const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════════════
//  GROQ API PROXY  (replaces Anthropic)
//  Model: llama-3.3-70b-versatile — 128k context, ~500 tok/s
// ═══════════════════════════════════════════════════════════
app.post('/api/groq', async (req, res) => {
  const key = req.headers['x-groq-key'];
  if (!key) return res.status(401).json({ error: 'Missing Groq API key' });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: req.body.model || 'llama-3.3-70b-versatile',
        messages: req.body.messages || [],
        max_tokens: req.body.max_tokens || 4096,
        temperature: req.body.temperature ?? 0.4,
        stream: false
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[Groq Error]', JSON.stringify(data));
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error('[Groq Proxy Error]', err.message);
    res.status(500).json({ error: 'Groq proxy failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  BOOK SOURCE ENGINE — Cascading Search
//  Priority: Z-Library → LibGen → Anna's Archive
// ═══════════════════════════════════════════════════════════

const TIMEOUT_MS = 12000;

function makeHeaders(referer) {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Connection': 'keep-alive',
    'Referer': referer || 'https://www.google.com/',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0'
  };
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, headers: { ...makeHeaders(url), ...(opts.headers || {}) } });
    clearTimeout(tid);
    return res;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// ── Z-Library Search ──────────────────────────────────────
async function searchZlib(query, author) {
  const results = [];
  const q = encodeURIComponent(author ? `${query} ${author}` : query);

  // Try multiple Z-Lib domains (they rotate due to blocks)
  const domains = [
    'https://z-library.sk',
    'https://z-lib.io',
    'https://1lib.sk'
  ];

  for (const domain of domains) {
    try {
      const url = `${domain}/s/${encodeURIComponent(query)}`;
      const res = await fetchWithTimeout(url, {}, 10000);
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      // Z-Lib book cards use .resItemBox or .bookItem selectors
      const cards = $('[class*="resItem"], [class*="bookItem"], .book-item, .item');
      if (cards.length === 0) {
        // Try the search results page format
        $('article, .result-item, [data-book_id]').each((_, el) => {
          const titleEl = $(el).find('h3 a, .title a, a.color-dark').first();
          const title = titleEl.text().trim();
          const href = titleEl.attr('href');
          const authorText = $(el).find('.authors, .book-author, a[href*="/author/"]').first().text().trim();
          const formatText = $(el).find('.property_files .book-property__value, .format').first().text().trim().toUpperCase();
          const sizeText = $(el).find('.property_files, .size').last().text().trim();

          if (title && href) {
            results.push({
              title: title.slice(0, 120),
              author: authorText || 'Unknown',
              format: formatText || 'PDF/EPUB',
              fileSize: sizeText || '?',
              url: href.startsWith('http') ? href : `${domain}${href}`,
              source: 'Z-Library',
              sourceIcon: '📚'
            });
          }
        });
      } else {
        cards.each((_, el) => {
          const titleEl = $(el).find('h3 a, h2 a, .title a').first();
          const title = titleEl.text().trim();
          const href = titleEl.attr('href');
          const authorText = $(el).find('.authors, .book-author, [class*="author"]').first().text().trim();
          const formatText = $(el).find('[class*="format"], .property_files .book-property__value').first().text().trim();
          const sizeText = $(el).find('[class*="size"], .property_files').last().text().trim();
          
          if (title && href) {
            results.push({
              title: title.slice(0, 120),
              author: authorText || 'Unknown',
              format: formatText.toUpperCase() || 'PDF/EPUB',
              fileSize: sizeText || '?',
              url: href.startsWith('http') ? href : `${domain}${href}`,
              source: 'Z-Library',
              sourceIcon: '📚'
            });
          }
        });
      }

      if (results.length > 0) {
        console.log(`[Z-Lib] Found ${results.length} results from ${domain}`);
        break; // Success — no need to try other domains
      }
    } catch (e) {
      console.warn(`[Z-Lib] ${domain} failed:`, e.message);
    }
  }

  return results.slice(0, 8);
}

// ── LibGen Search ─────────────────────────────────────────
async function searchLibgen(query) {
  const results = [];
  const q = encodeURIComponent(query);

  const mirrors = [
    `http://libgen.rs/search.php?req=${q}&res=25&column=def`,
    `http://libgen.is/search.php?req=${q}&res=25&column=def`
  ];

  for (const url of mirrors) {
    try {
      const res = await fetchWithTimeout(url, {}, 10000);
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      // LibGen table structure: #content table tbody tr
      $('table#c tbody tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 9) return;
        
        const titleEl = $(cells[2]).find('a[href*="book/index"]').first();
        const title = titleEl.text().trim();
        const author = $(cells[1]).text().trim();
        const ext = $(cells[8]).text().trim().toUpperCase();
        const size = $(cells[7]).text().trim();
        const md5 = $(cells[9] || cells[8]).text().trim().toLowerCase().replace(/[^a-f0-9]/g, '');
        const href = titleEl.attr('href');
        
        if (title && ext) {
          // Build a LibGen download link from MD5 if available
          const downloadUrl = md5 && md5.length === 32
            ? `http://library.lol/main/${md5}`
            : href ? `http://libgen.rs/${href}` : url;
          
          results.push({
            title: title.slice(0, 120),
            author: author || 'Unknown',
            format: ext || 'PDF',
            fileSize: size || '?',
            url: downloadUrl,
            source: 'Library Genesis',
            sourceIcon: '🏛️'
          });
        }
      });

      if (results.length > 0) {
        console.log(`[LibGen] Found ${results.length} results`);
        break;
      }
    } catch (e) {
      console.warn(`[LibGen] Failed:`, e.message);
    }
  }

  return results.slice(0, 8);
}

// ── Anna's Archive Search ─────────────────────────────────
async function searchAnnasArchive(query) {
  const results = [];
  
  try {
    const url = `https://annas-archive.org/search?q=${encodeURIComponent(query)}&lang=en&content=book_fiction,book_nonfiction&sort=&ext=pdf,epub`;
    const res = await fetchWithTimeout(url, {}, 12000);
    if (!res.ok) throw new Error('Non-OK: ' + res.status);
    const html = await res.text();
    const $ = cheerio.load(html);

    // Anna's Archive uses specific card structures
    $('a[href^="/md5/"]').each((_, el) => {
      const card = $(el);
      const href = card.attr('href');
      const title = card.find('[class*="title"], h3, .text-xl, .font-bold').first().text().trim()
        || card.find('div').first().text().trim().slice(0, 80);
      const meta = card.find('[class*="text-sm"], [class*="text-xs"]').first().text().trim();
      const formatMatch = meta.match(/\b(PDF|EPUB|MOBI|AZW3|DJVU)\b/i);
      const sizeMatch = meta.match(/\d+(\.\d+)?\s*(MB|KB|GB)/i);

      if (href && title) {
        results.push({
          title: title.slice(0, 120),
          author: '',
          format: formatMatch ? formatMatch[0].toUpperCase() : 'PDF/EPUB',
          fileSize: sizeMatch ? sizeMatch[0] : '?',
          url: `https://annas-archive.org${href}`,
          source: "Anna's Archive",
          sourceIcon: '📖'
        });
      }
    });

    console.log(`[Anna's Archive] Found ${results.length} results`);
  } catch (e) {
    console.warn(`[Anna's Archive] Failed:`, e.message);
  }

  return results.slice(0, 8);
}

// ── PRIMARY SEARCH: Z-Library only ───────────────────────
app.get('/api/book-search', async (req, res) => {
  const { q, author } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter ?q=' });

  console.log(`[Book Search] Primary search: "${q}" by "${author || 'any'}"`);

  try {
    const results = await searchZlib(q, author);

    if (results.length > 0) {
      return res.json({ results, source: 'Z-Library', hasMore: true });
    }

    // Z-Lib came up empty — signal frontend to show "Extensive Search" button
    return res.json({ results: [], source: 'Z-Library', hasMore: true, empty: true });
  } catch (err) {
    console.error('[Book Search Error]', err.message);
    res.json({ results: [], source: 'Z-Library', hasMore: true, empty: true, error: err.message });
  }
});

// ── EXTENDED SEARCH: LibGen + Anna's Archive ─────────────
app.get('/api/book-extended', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter ?q=' });

  console.log(`[Extended Search] "${q}"`);

  try {
    // Run both in parallel for maximum speed
    const [libgenResults, annasResults] = await Promise.allSettled([
      searchLibgen(q),
      searchAnnasArchive(q)
    ]);

    const results = [
      ...(libgenResults.status === 'fulfilled' ? libgenResults.value : []),
      ...(annasResults.status === 'fulfilled' ? annasResults.value : [])
    ];

    res.json({ results, sources: ['Library Genesis', "Anna's Archive"] });
  } catch (err) {
    console.error('[Extended Search Error]', err.message);
    res.json({ results: [], sources: [], error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', version: '2.0', engine: 'groq+scraper' }));

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║        SKILL FORGE v2.0 — SERVER         ║`);
  console.log(`║  ⚡ Groq Engine (llama-3.3-70b)          ║`);
  console.log(`║  📚 Book Scraper: Z-Lib → LibGen → Anna  ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`\n  → http://localhost:${PORT}/\n`);
});
