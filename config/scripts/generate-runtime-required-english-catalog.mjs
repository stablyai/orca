import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  collectLocalizationKeyReferences,
  collectSourceFiles,
  LOCALIZATION_SOURCE_ROOTS
} from './verify-localization-catalog.mjs'

export const EN_CATALOG_RELATIVE_PATH = path.join(
  'src',
  'renderer',
  'src',
  'i18n',
  'locales',
  'en.json'
)
export const RUNTIME_REQUIRED_RELATIVE_PATH = path.join(
  'src',
  'renderer',
  'src',
  'i18n',
  'en-runtime-required.json'
)

// CLDR categories i18next appends to a key when `count` is supplied. i18next
// never derives a plural form from `defaultValue`, so a suffixed entry is only
// ever served from the catalog.
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/

function flattenCatalogEntries(value, prefix = '', entries = new Map()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return entries
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return entries
  }
  for (const [key, child] of Object.entries(value)) {
    flattenCatalogEntries(child, prefix ? `${prefix}.${key}` : key, entries)
  }
  return entries
}

/**
 * English entries i18next cannot reproduce from the call site's `defaultValue`.
 *
 * `translate(key, fallback)` always passes a default, and for the default
 * locale i18next prefers the catalog entry and only then the default — so an
 * entry whose every call site already spells the identical string is dead
 * weight in the boot bundle. An entry is kept when any of these hold:
 *   - it carries a CLDR plural suffix (resolved from the catalog, never a default),
 *   - no call site with a literal default references it (dynamic key or
 *     dynamic default: the runtime default is unknown and the catalog wins today),
 *   - some call site's literal default differs from the catalog value (the
 *     catalog value is what ships today).
 */
export function collectRuntimeRequiredKeys(catalogEntries, references) {
  const literalFallbacksByKey = new Map()
  const dynamicFallbackKeys = new Set()

  for (const reference of references) {
    if (typeof reference.fallback === 'string') {
      const fallbacks = literalFallbacksByKey.get(reference.key) ?? new Set()
      fallbacks.add(reference.fallback)
      literalFallbacksByKey.set(reference.key, fallbacks)
      continue
    }
    dynamicFallbackKeys.add(reference.key)
  }

  const required = new Set()
  for (const [key, value] of catalogEntries) {
    if (PLURAL_SUFFIX_RE.test(key)) {
      required.add(key)
      continue
    }
    const fallbacks = literalFallbacksByKey.get(key)
    if (!fallbacks || dynamicFallbackKeys.has(key)) {
      required.add(key)
      continue
    }
    if (fallbacks.size !== 1 || !fallbacks.has(value)) {
      required.add(key)
    }
  }
  return required
}

export function buildRuntimeRequiredCatalog(catalogEntries, requiredKeys) {
  const catalog = {}
  for (const key of [...requiredKeys].sort()) {
    const parts = key.split('.')
    let cursor = catalog
    for (const part of parts.slice(0, -1)) {
      cursor[part] ??= {}
      cursor = cursor[part]
    }
    cursor[parts.at(-1)] = catalogEntries.get(key)
  }
  return catalog
}

async function collectReferences(root) {
  const references = []
  for (const sourceRoot of LOCALIZATION_SOURCE_ROOTS) {
    const files = await collectSourceFiles(root, path.join(root, sourceRoot))
    for (const filePath of files) {
      references.push(
        ...collectLocalizationKeyReferences(filePath, await fs.readFile(filePath, 'utf8'), root)
      )
    }
  }
  return references
}

export async function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const fix = argv.includes('--fix')
  const catalogEntries = flattenCatalogEntries(
    JSON.parse(await fs.readFile(path.join(root, EN_CATALOG_RELATIVE_PATH), 'utf8'))
  )
  const references = await collectReferences(root)
  const requiredKeys = collectRuntimeRequiredKeys(catalogEntries, references)
  const expected = `${JSON.stringify(buildRuntimeRequiredCatalog(catalogEntries, requiredKeys), null, 2)}\n`
  const outputPath = path.join(root, RUNTIME_REQUIRED_RELATIVE_PATH)
  const actual = await fs.readFile(outputPath, 'utf8').catch(() => null)

  if (actual === expected) {
    console.log(
      `en-runtime-required.json is current: ${requiredKeys.size} of ${catalogEntries.size} English entries must ship in the boot bundle.`
    )
    return 0
  }

  if (!fix) {
    console.error(
      'src/renderer/src/i18n/en-runtime-required.json is stale (it is generated from en.json plus the inline defaults at each call site).'
    )
    console.error('Run `pnpm run sync:localization-runtime-catalog` to regenerate it.')
    return 1
  }

  await fs.writeFile(outputPath, expected, 'utf8')
  console.log(
    `Wrote ${requiredKeys.size} of ${catalogEntries.size} English entries to en-runtime-required.json.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
