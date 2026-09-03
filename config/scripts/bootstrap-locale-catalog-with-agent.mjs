import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import {
  collectStringLeaves,
  repairCatalog,
  repairTranslatedValue,
  setLeaf,
  shouldPreserveEnglishValue
} from './locale-translation-policy.mjs'

// Why: unlike bootstrap-locale-catalog.mjs (Google Translate, one string per
// HTTP call), an instruction-following model can translate a whole batch per
// call and follow a style/glossary prompt — worth a separate script rather
// than bolting a second translation backend onto the working MT pipeline.

const execFileAsync = promisify(execFile)
const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

const LOCALE_CONFIG = {
  pt: {
    displayName: 'Brazilian Portuguese (pt-BR)',
    cacheFile: '.pt-catalog-cache.json'
  }
}

const AGENT_COMMAND = 'antigravity'
const AGENT_MODEL = 'gemini-3.7-flash-high'
const BATCH_SIZE = 300
const CONCURRENCY = 4
const MAX_BATCH_ATTEMPTS = 3

const GLOSSARY = `You are localizing the UI of Orca, a Git-based developer tool (terminal
sessions, worktrees, agents, source control) into Brazilian Portuguese (pt-BR).

Style: match how GitHub Desktop, Linear, and VS Code read in pt-BR — natural,
concise, professional, not overly formal, not literal machine-translation
phrasing.

Keep these as literal English loanwords, never translate them, even inside a
translated sentence (this is the established convention already used in this
app's es/ja/ko/zh catalogs):
worktree, repo, commit, branch, HEAD, upstream, remote, staged, unstaged,
diff, hunk, stash, rebase, merge, checkout, fetch, push, pull, PTY, daemon,
pane, tab, agent, session, terminal (as in "terminal pane"), token, prompt.

Rules:
- Translate every string value. Never leave a string in English unless it is
  one of the loanwords above or a proper noun.
- Preserve every {{value0}}-style placeholder EXACTLY as-is, same count, same
  spelling, never translate or reword its contents.
- Preserve punctuation style (e.g. an ellipsis "..." stays "...").
- Keep capitalization sentence-case unless the English is a short label/button
  (Title Case labels can become natural pt-BR sentence case, e.g. "Open in
  Browser" -> "Abrir no navegador").`

function protectPlaceholders(text) {
  const tokens = []
  const protectedText = text.replace(PLACEHOLDER_RE, (match) => {
    const token = `__PH${tokens.length}__`
    tokens.push(match)
    return token
  })
  return { protectedText, tokens }
}

function restorePlaceholders(text, tokens) {
  let result = text
  for (let index = 0; index < tokens.length; index += 1) {
    const patterns = [`__PH${index}__`, `__ PH ${index} __`, `__PH ${index}__`, `__ PH${index}__`]
    for (const pattern of patterns) {
      result = result.replaceAll(pattern, tokens[index])
    }
  }
  return result
}

function hasMatchingPlaceholders(source, translated) {
  const sourcePlaceholders = (source.match(PLACEHOLDER_RE) ?? []).sort()
  const translatedPlaceholders = (translated.match(PLACEHOLDER_RE) ?? []).sort()
  return JSON.stringify(sourcePlaceholders) === JSON.stringify(translatedPlaceholders)
}

async function callAgent(prompt) {
  const { stdout } = await execFileAsync(
    AGENT_COMMAND,
    ['-p', prompt, '--model', AGENT_MODEL, '--output-format', 'json'],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const parsed = JSON.parse(stdout)
  if (parsed.status !== 'SUCCESS') {
    throw new Error(`agent call failed: ${parsed.status}`)
  }
  return parsed.response
}

function extractJsonObject(response) {
  const start = response.indexOf('{')
  const end = response.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('agent response has no JSON object')
  }
  return JSON.parse(response.slice(start, end + 1))
}

async function translateBatch(values, displayName) {
  const entries = values.map((value, index) => {
    const { protectedText, tokens } = protectPlaceholders(value)
    return { index, value, protectedText, tokens }
  })
  const payload = Object.fromEntries(entries.map((e) => [String(e.index), e.protectedText]))
  const prompt = `${GLOSSARY}

Translate the string VALUES of this JSON object into ${displayName}. Keep the
exact same keys. Reply with ONLY the translated JSON object — no markdown
fences, no explanation.

${JSON.stringify(payload)}`

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await callAgent(prompt)
      const translated = extractJsonObject(response)
      const result = new Map()
      for (const entry of entries) {
        const raw = translated[String(entry.index)]
        if (typeof raw !== 'string') {
          throw new Error(`missing translation for index ${entry.index}`)
        }
        const restored = restorePlaceholders(raw, entry.tokens)
        if (!hasMatchingPlaceholders(entry.value, restored)) {
          // Why: a dropped/mangled placeholder breaks interpolation at
          // render time — fall back to English for just this one string
          // rather than failing (or shipping broken output for) the batch.
          console.warn(`  placeholder mismatch, keeping English: ${JSON.stringify(entry.value)}`)
          result.set(entry.value, entry.value)
          continue
        }
        result.set(entry.value, restored)
      }
      return result
    } catch (error) {
      console.warn(`  batch attempt ${attempt} failed: ${error.message}`)
      if (attempt === MAX_BATCH_ATTEMPTS) {
        throw error
      }
    }
  }
  throw new Error('unreachable')
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = Array.from({ length: items.length })
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function chunk(array, size) {
  const chunks = []
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size))
  }
  return chunks
}

async function loadCache(cachePath) {
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, 'utf8'))
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

async function saveCache(cachePath, cache) {
  const raw = Object.fromEntries(cache.entries())
  await fs.writeFile(cachePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

function parseLocaleArg(argv) {
  const localeFlagIndex = argv.indexOf('--locale')
  if (localeFlagIndex !== -1 && argv[localeFlagIndex + 1]) {
    return argv[localeFlagIndex + 1]
  }
  return argv[2]
}

export async function main(root = process.cwd(), locale = parseLocaleArg(process.argv)) {
  const config = LOCALE_CONFIG[locale]
  if (!config) {
    console.error(
      `Unsupported locale "${locale}". Supported: ${Object.keys(LOCALE_CONFIG).join(', ')}`
    )
    return 1
  }

  const enPath = path.join(root, LOCALES_DIR, 'en.json')
  const localePath = path.join(root, LOCALES_DIR, `${locale}.json`)
  const cachePath = path.join(root, LOCALES_DIR, config.cacheFile)
  const enCatalog = JSON.parse(await fs.readFile(enPath, 'utf8'))
  const localeCatalog = structuredClone(enCatalog)
  const leaves = collectStringLeaves(enCatalog)
  const uniqueValues = [...new Set(leaves.map((leaf) => leaf.value))]
  const cache = await loadCache(cachePath)
  const toTranslate = uniqueValues.filter(
    (value) => !shouldPreserveEnglishValue(value) && !cache.has(value)
  )

  console.log(
    `Translating ${toTranslate.length} unique strings to ${config.displayName} ` +
      `(${cache.size} cached) in batches of ${BATCH_SIZE}, concurrency ${CONCURRENCY}...`
  )

  const batches = chunk(toTranslate, BATCH_SIZE)
  let completedBatches = 0
  await mapWithConcurrency(batches, CONCURRENCY, async (batch) => {
    const translated = await translateBatch(batch, config.displayName)
    for (const [enValue, localeValue] of translated) {
      cache.set(enValue, repairTranslatedValue({ key: '', enValue, localeValue, locale }))
    }
    completedBatches += 1
    console.log(`  batch ${completedBatches}/${batches.length} done`)
    await saveCache(cachePath, cache)
  })

  for (const value of uniqueValues) {
    if (shouldPreserveEnglishValue(value) && !cache.has(value)) {
      cache.set(value, value)
    }
  }

  await saveCache(cachePath, cache)

  for (const leaf of leaves) {
    const cached = cache.get(leaf.value) ?? leaf.value
    setLeaf(
      localeCatalog,
      leaf.key,
      repairTranslatedValue({ key: leaf.key, enValue: leaf.value, localeValue: cached, locale })
    )
  }

  repairCatalog(enCatalog, localeCatalog, locale)

  await fs.writeFile(localePath, `${JSON.stringify(localeCatalog, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${localePath}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
