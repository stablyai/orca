import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { repairCacheMap, repairCatalog } from './locale-translation-policy.mjs'

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')

const LOCALE_CACHE_FILES = {
  ko: '.ko-catalog-cache.json',
  zh: '.zh-catalog-cache.json',
  ja: '.ja-catalog-cache.json',
  es: '.es-catalog-cache.json'
}

function parseLocaleArg(argv) {
  const localeFlagIndex = argv.indexOf('--locale')
  if (localeFlagIndex !== -1 && argv[localeFlagIndex + 1]) {
    return argv[localeFlagIndex + 1]
  }
  return undefined
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
  const raw = Object.fromEntries([...cache.entries()].sort(([a], [b]) => a.localeCompare(b)))
  await fs.writeFile(cachePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

export async function repairLocale(root, locale) {
  const enPath = path.join(root, LOCALES_DIR, 'en.json')
  const localePath = path.join(root, LOCALES_DIR, `${locale}.json`)
  const cachePath = path.join(root, LOCALES_DIR, LOCALE_CACHE_FILES[locale])

  const enCatalog = JSON.parse(await fs.readFile(enPath, 'utf8'))
  const localeCatalog = JSON.parse(await fs.readFile(localePath, 'utf8'))
  const cache = await loadCache(cachePath)

  const catalogRepairs = repairCatalog(enCatalog, localeCatalog, locale)
  const cacheRepairs = repairCacheMap(cache, locale)

  await fs.writeFile(localePath, `${JSON.stringify(localeCatalog, null, 2)}\n`, 'utf8')
  await saveCache(cachePath, cache)

  console.log(`Repaired ${locale}.json (${catalogRepairs} leaf updates)`)
  console.log(`Repaired ${LOCALE_CACHE_FILES[locale]} (${cacheRepairs} cache updates)`)
  return { catalogRepairs, cacheRepairs }
}

export async function main(root = process.cwd(), locale = parseLocaleArg(process.argv)) {
  const locales = locale ? [locale] : ['ko', 'zh', 'ja', 'es']
  const unsupported = locales.filter((code) => !LOCALE_CACHE_FILES[code])
  if (unsupported.length > 0) {
    console.error(`Unsupported locale(s): ${unsupported.join(', ')}`)
    return 1
  }

  for (const code of locales) {
    await repairLocale(root, code)
  }

  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
