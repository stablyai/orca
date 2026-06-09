import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g
const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')

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

function collectStringLeaves(value, prefix = '', leaves = []) {
  if (typeof value === 'string') {
    leaves.push({ key: prefix, value })
    return leaves
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return leaves
  }
  for (const [key, child] of Object.entries(value)) {
    collectStringLeaves(child, prefix ? `${prefix}.${key}` : key, leaves)
  }
  return leaves
}

function setLeaf(catalog, key, translatedValue) {
  const parts = key.split('.')
  let cursor = catalog
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = cursor[parts[index]]
  }
  cursor[parts.at(-1)] = translatedValue
}

function preserveBrandNames(catalog) {
  function walk(value) {
    if (typeof value === 'string') {
      return value.replaceAll('逆戟鲸', 'Orca')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value
    }
    for (const [key, child] of Object.entries(value)) {
      value[key] = walk(child)
    }
    return value
  }
  walk(catalog)
  if (catalog.menu) {
    catalog.menu.exit = '退出'
    catalog.menu.exploreOrca = '探索 Orca'
    catalog.menu.gettingStarted = 'Orca 入门'
  }
}

function shouldSkipTranslation(text) {
  if (!text.trim()) {
    return true
  }
  if (/^https?:\/\//.test(text)) {
    return true
  }
  return false
}

async function translateToSimplifiedChinese(text) {
  const url = new URL('https://translate.googleapis.com/translate_a/single')
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('sl', 'en')
  url.searchParams.set('tl', 'zh-CN')
  url.searchParams.set('dt', 't')
  url.searchParams.set('q', text)

  let lastError
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Translation request failed with status ${response.status}`)
      }
      const payload = await response.json()
      return payload[0].map((part) => part[0]).join('')
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw lastError
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

export async function main(root = process.cwd()) {
  const enPath = path.join(root, LOCALES_DIR, 'en.json')
  const zhPath = path.join(root, LOCALES_DIR, 'zh.json')
  const cachePath = path.join(root, LOCALES_DIR, '.zh-catalog-cache.json')
  const enCatalog = JSON.parse(await fs.readFile(enPath, 'utf8'))
  const zhCatalog = structuredClone(enCatalog)
  const leaves = collectStringLeaves(enCatalog)
  const uniqueValues = [...new Set(leaves.map((leaf) => leaf.value))]
  const cache = await loadCache(cachePath)
  const toTranslate = uniqueValues.filter(
    (value) => !shouldSkipTranslation(value) && !cache.has(value)
  )

  console.log(
    `Translating ${toTranslate.length} unique strings to Simplified Chinese (${cache.size} cached)...`
  )

  let completed = 0
  await mapWithConcurrency(toTranslate, 2, async (value) => {
    completed += 1
    if (completed % 25 === 0) {
      console.log(`  ${completed}/${toTranslate.length}`)
      await saveCache(cachePath, cache)
    }
    const { protectedText, tokens } = protectPlaceholders(value)
    const translated = await translateToSimplifiedChinese(protectedText)
    cache.set(value, restorePlaceholders(translated, tokens))
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  await saveCache(cachePath, cache)

  for (const leaf of leaves) {
    setLeaf(zhCatalog, leaf.key, cache.get(leaf.value) ?? leaf.value)
  }

  // Why: keep the picker label native — machine translation often mangles script names.
  if (zhCatalog.settings?.appearance?.language) {
    zhCatalog.settings.appearance.language.chinese = '中文（简体）'
  }

  preserveBrandNames(zhCatalog)

  await fs.writeFile(zhPath, `${JSON.stringify(zhCatalog, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${zhPath}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
