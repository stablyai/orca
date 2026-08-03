import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  countCatalogRepairDrifts,
  repairCacheMap,
  repairCatalog
} from './locale-translation-policy.mjs'

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

function wantsCheckOnly(argv) {
  return argv.includes('--check')
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

export async function repairLocale(root, locale, { checkOnly = false } = {}) {
  const enPath = path.join(root, LOCALES_DIR, 'en.json')
  const localePath = path.join(root, LOCALES_DIR, `${locale}.json`)
  const cachePath = path.join(root, LOCALES_DIR, LOCALE_CACHE_FILES[locale])

  const enCatalog = JSON.parse(await fs.readFile(enPath, 'utf8'))
  const localeCatalog = JSON.parse(await fs.readFile(localePath, 'utf8'))

  if (checkOnly) {
    const catalogDrifts = countCatalogRepairDrifts(enCatalog, localeCatalog, locale)
    const cache = await loadCache(cachePath)
    const cacheClone = new Map(cache)
    const cacheDrifts = repairCacheMap(cacheClone, locale)
    if (catalogDrifts > 0 || cacheDrifts > 0) {
      console.error(
        `${locale}: catalog drifts=${catalogDrifts}, cache drifts=${cacheDrifts}. Re-run without --check to apply.`
      )
      return { catalogRepairs: catalogDrifts, cacheRepairs: cacheDrifts, clean: false }
    }
    console.log(`${locale}: repair-clean (0 catalog, 0 cache drifts)`)
    return { catalogRepairs: 0, cacheRepairs: 0, clean: true }
  }

  const cache = await loadCache(cachePath)
  const catalogRepairs = repairCatalog(enCatalog, localeCatalog, locale)
  const cacheRepairs = repairCacheMap(cache, locale)

  await fs.writeFile(localePath, `${JSON.stringify(localeCatalog, null, 2)}\n`, 'utf8')
  await saveCache(cachePath, cache)

  console.log(`Repaired ${locale}.json (${catalogRepairs} leaf updates)`)
  console.log(`Repaired ${LOCALE_CACHE_FILES[locale]} (${cacheRepairs} cache updates)`)
  return { catalogRepairs, cacheRepairs, clean: catalogRepairs === 0 && cacheRepairs === 0 }
}

export async function main(
  root = process.cwd(),
  locale = parseLocaleArg(process.argv),
  checkOnly = wantsCheckOnly(process.argv)
) {
  const locales = locale ? [locale] : ['ko', 'zh', 'ja', 'es']
  const unsupported = locales.filter((code) => !LOCALE_CACHE_FILES[code])
  if (unsupported.length > 0) {
    console.error(`Unsupported locale(s): ${unsupported.join(', ')}`)
    return 1
  }

  let dirty = false
  for (const code of locales) {
    const result = await repairLocale(root, code, { checkOnly })
    if (checkOnly && !result.clean) {
      dirty = true
    }
  }

  return dirty ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
