import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const SUPPORTED_LOCALES = new Set(['de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'])
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g

function placeholders(value) {
  return [...(value.match(PLACEHOLDER_RE) ?? [])].sort().join('|')
}

function getEntry(catalog, key) {
  return key.split('.').reduce((cursor, part) => cursor?.[part], catalog)
}

function setEntry(catalog, key, value) {
  const parts = key.split('.')
  let cursor = catalog
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
}

function getEn(catalog, key, locale) {
  // Why: locales with more CLDR plural categories than English (ru few/many) translate from `_other`.
  const plural = /^(.*)_(zero|one|two|few|many|other)$/.exec(key)
  const value =
    getEntry(catalog, key) ??
    (plural && new Intl.PluralRules(locale).resolvedOptions().pluralCategories.includes(plural[2])
      ? getEntry(catalog, `${plural[1]}_other`)
      : undefined)
  if (typeof value !== 'string') {
    throw new Error(`en.json has no string entry for ${key}`)
  }
  return value
}

async function main() {
  const root = process.cwd()
  const translationsPath = process.argv[2] ?? '/tmp/translations.json'
  const translations = JSON.parse(await fs.readFile(translationsPath, 'utf8'))
  const enCatalog = JSON.parse(await fs.readFile(path.join(root, LOCALES_DIR, 'en.json'), 'utf8'))

  for (const [locale, entries] of Object.entries(translations)) {
    // Why: the locale becomes a path segment, so an unchecked key could write outside LOCALES_DIR.
    if (!SUPPORTED_LOCALES.has(locale)) {
      throw new Error(`Unsupported locale: ${locale}`)
    }
    const localePath = path.join(root, LOCALES_DIR, `${locale}.json`)
    const localeCatalog = JSON.parse(await fs.readFile(localePath, 'utf8'))
    let added = 0
    let skipped = 0
    for (const [key, rawValue] of Object.entries(entries)) {
      if (getEntry(localeCatalog, key) !== undefined) {
        console.log(`[${locale}] already present, skip: ${key}`)
        skipped += 1
        continue
      }
      const enValue = getEn(enCatalog, key, locale)
      if (placeholders(enValue) !== placeholders(rawValue)) {
        throw new Error(
          `[${locale}] placeholder mismatch for ${key}: en=${placeholders(enValue)} vs locale=${placeholders(rawValue)}`
        )
      }
      const repaired = repairTranslatedValue({
        key,
        enValue,
        localeValue: rawValue,
        locale
      })
      if (placeholders(enValue) !== placeholders(repaired)) {
        throw new Error(
          `[${locale}] repair broke placeholders for ${key}: ${JSON.stringify(repaired)}`
        )
      }
      if (repaired !== rawValue) {
        console.log(
          `[${locale}] policy repair adjusted ${key}: ${JSON.stringify(rawValue)} -> ${JSON.stringify(repaired)}`
        )
      }
      setEntry(localeCatalog, key, repaired)
      added += 1
    }
    // Why: write-then-rename so an interrupted run can't leave the catalog truncated.
    const tmpPath = `${localePath}.${process.pid}.tmp`
    await fs.writeFile(tmpPath, `${JSON.stringify(localeCatalog, null, 2)}\n`, 'utf8')
    await fs.rename(tmpPath, localePath)
    console.log(`[${locale}] added ${added}, skipped ${skipped}`)
  }
}

await main()
