// Generates src/renderer/src/i18n/locales/zh-Hant.json from zh.json.
//
// Usage: node config/scripts/generate-zh-hant-catalog.mjs [--check]
//
// Why derived from Simplified rather than translated from English: the Simplified
// catalog carries reviewed terminology and Orca glossary decisions that a fresh
// English→Traditional translation would have to rediscover, and a script
// conversion cannot regress a term that catalog already settled. Deriving the
// key set from zh.json also inherits its sparseness — a key zh.json leaves to
// the English runtime fallback stays absent here for the same reason.
// `--check` regenerates in memory and fails if the committed file differs.
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  collectStringLeaves,
  convertCatalogLeaves,
  convertValueToTraditional
} from './zh-hant-catalog.mjs'
import { ZHT_KEY_OVERRIDES } from './locale-zht-key-overrides.mjs'

export const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
export const ZHT_CATALOG_FILE = 'zh-Hant.json'

/** Traditional value for one leaf; a pinned key wins over the conversion. */
export function convertLeaf(zhValue, key) {
  return ZHT_KEY_OVERRIDES[key] ?? convertValueToTraditional(zhValue)
}

export function buildZhHantCatalog({ zhCatalog }) {
  return convertCatalogLeaves(zhCatalog, convertLeaf)
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`
}

export async function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const zhCatalogPath = path.join(root, LOCALES_DIR, 'zh.json')
  let zhCatalog
  try {
    zhCatalog = JSON.parse(await fs.readFile(zhCatalogPath, 'utf8'))
  } catch (error) {
    // Why: only an absent zh.json means there is nothing to derive. Unreadable
    // or malformed, the only source of zh-Hant, has to fail the check.
    if (error?.code !== 'ENOENT') {
      throw error
    }
    // Why: zh-Hant is derived from zh.json, so a tree without one (the
    // combined verifier's synthetic fixtures) has nothing to derive or check.
    console.log(`${ZHT_CATALOG_FILE} is derived from zh.json, which is absent here.`)
    return 0
  }

  const catalog = buildZhHantCatalog({ zhCatalog })
  const catalogPath = path.join(root, LOCALES_DIR, ZHT_CATALOG_FILE)
  const expected = serializeCatalog(catalog)

  if (argv.includes('--check')) {
    let actual
    try {
      actual = await fs.readFile(catalogPath, 'utf8')
    } catch {
      console.error(`${ZHT_CATALOG_FILE} is missing. Run \`pnpm run sync:zh-hant-catalog\`.`)
      return 1
    }
    if (actual !== expected) {
      console.error(
        `${ZHT_CATALOG_FILE} is out of date with zh.json. Run \`pnpm run sync:zh-hant-catalog\`.`
      )
      return 1
    }
    console.log(`${ZHT_CATALOG_FILE} matches zh.json.`)
    return 0
  }

  await fs.writeFile(catalogPath, expected, 'utf8')
  console.log(`Wrote ${catalogPath} (${collectStringLeaves(catalog).length} entries).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
