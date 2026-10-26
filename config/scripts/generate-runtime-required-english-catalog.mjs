import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { collectLocalizationReferences } from './verify-localization-catalog.mjs'

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

// i18next resolves CLDR plural suffixes only from catalog, never defaultValue.
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

// Retain catalog entries when plural-suffixed, lacking literal defaults or differing from any call-site default.
// Catalog wins over defaults; only entries identical at every literal-default call site are redundant in the boot bundle.
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

// Require all needed entries and agreement with en.json, not exact subset equality.
// Formerly required extras only cost bytes; allowing them avoids unrelated key additions invalidating open branches.
export function collectRuntimeRequiredCatalogProblems(catalogEntries, requiredKeys, shipped) {
  const missing = [...requiredKeys].filter((key) => !shipped.has(key)).sort()
  const contradicting = [...shipped.keys()]
    .filter((key) => catalogEntries.get(key) !== shipped.get(key))
    .sort()
  const superfluous = [...shipped.keys()].filter(
    (key) => !requiredKeys.has(key) && catalogEntries.has(key)
  )
  return { missing, contradicting, superfluous }
}

function reportKeys(label, keys) {
  console.error(`${label}:`)
  for (const key of keys.slice(0, 20)) {
    console.error(`  ${key}`)
  }
  if (keys.length > 20) {
    console.error(`  ...and ${keys.length - 20} more`)
  }
}

export async function main(root = process.cwd(), argv = process.argv.slice(2), sharedReferences) {
  const fix = argv.includes('--fix')
  const catalogEntries = flattenCatalogEntries(
    JSON.parse(await fs.readFile(path.join(root, EN_CATALOG_RELATIVE_PATH), 'utf8'))
  )
  const references = sharedReferences ?? (await collectLocalizationReferences(root))
  const requiredKeys = collectRuntimeRequiredKeys(catalogEntries, references)
  const outputPath = path.join(root, RUNTIME_REQUIRED_RELATIVE_PATH)

  if (fix) {
    const catalog = buildRuntimeRequiredCatalog(catalogEntries, requiredKeys)
    await fs.writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    console.log(
      `Wrote ${requiredKeys.size} of ${catalogEntries.size} English entries to en-runtime-required.json.`
    )
    return 0
  }

  const shipped = flattenCatalogEntries(JSON.parse(await fs.readFile(outputPath, 'utf8')))
  const { missing, contradicting, superfluous } = collectRuntimeRequiredCatalogProblems(
    catalogEntries,
    requiredKeys,
    shipped
  )

  if (missing.length > 0 || contradicting.length > 0) {
    console.error('src/renderer/src/i18n/en-runtime-required.json no longer covers en.json.')
    console.error('')
    if (missing.length > 0) {
      reportKeys(
        'Entries i18next cannot rebuild from a call site default, but that are not shipped',
        missing
      )
    }
    if (contradicting.length > 0) {
      reportKeys('Shipped entries whose text disagrees with en.json', contradicting)
    }
    console.error('')
    console.error('Run `pnpm run sync:localization-runtime-catalog` to regenerate it.')
    return 1
  }

  const superfluousNote =
    superfluous.length > 0
      ? `, ${superfluous.length} shipped entry/entries are no longer required (harmless; sync to drop them).`
      : '.'
  console.log(
    `en-runtime-required.json covers en.json: ${requiredKeys.size} of ${catalogEntries.size} English entries must ship in the boot bundle${superfluousNote}`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
