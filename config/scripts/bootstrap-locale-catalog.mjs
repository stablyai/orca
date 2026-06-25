import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  collectStringLeaves,
  repairCatalog,
  repairTranslatedValue,
  setLeaf,
  shouldPreserveEnglishValue
} from './locale-translation-policy.mjs'

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g
const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')

const LOCALE_CONFIG = {
  zh: {
    targetLanguage: 'zh-CN',
    displayName: 'Simplified Chinese',
    cacheFile: '.zh-catalog-cache.json'
  },
  ko: {
    targetLanguage: 'ko',
    displayName: 'Korean',
    cacheFile: '.ko-catalog-cache.json'
  },
  ja: {
    targetLanguage: 'ja',
    displayName: 'Japanese',
    cacheFile: '.ja-catalog-cache.json'
  },
  es: {
    targetLanguage: 'es',
    displayName: 'Spanish',
    cacheFile: '.es-catalog-cache.json'
  }
}

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

function shouldSkipTranslation(text) {
  return shouldPreserveEnglishValue(text)
}

async function translateText(text, targetLanguage) {
  const url = new URL('https://translate.googleapis.com/translate_a/single')
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('sl', 'en')
  url.searchParams.set('tl', targetLanguage)
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
    (value) => !shouldSkipTranslation(value) && !cache.has(value)
  )

  console.log(
    `Translating ${toTranslate.length} unique strings to ${config.displayName} (${cache.size} cached)...`
  )

  let completed = 0
  await mapWithConcurrency(toTranslate, 2, async (value) => {
    completed += 1
    if (completed % 25 === 0) {
      console.log(`  ${completed}/${toTranslate.length}`)
      await saveCache(cachePath, cache)
    }
    const { protectedText, tokens } = protectPlaceholders(value)
    const translated = await translateText(protectedText, config.targetLanguage)
    const restored = restorePlaceholders(translated, tokens)
    cache.set(
      value,
      repairTranslatedValue({ key: '', enValue: value, localeValue: restored, locale })
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  for (const value of uniqueValues) {
    if (shouldSkipTranslation(value) && !cache.has(value)) {
      cache.set(value, value)
    }
  }

  await saveCache(cachePath, cache)

  for (const leaf of leaves) {
    const cached = cache.get(leaf.value) ?? leaf.value
    setLeaf(
      localeCatalog,
      leaf.key,
      repairTranslatedValue({
        key: leaf.key,
        enValue: leaf.value,
        localeValue: cached,
        locale
      })
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
