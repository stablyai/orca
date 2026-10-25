import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { repairTranslatedValue } from './locale-translation-policy.mjs'
import { flattenCatalogEntries, resolveLocaleSourceKey } from './verify-localization-catalog.mjs'

const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const SUPPORTED_LOCALES = new Set(['es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh'])
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

function getEn(enEntries, locale, key) {
  const sourceKey = resolveLocaleSourceKey(enEntries, locale, key)
  const value = enEntries.get(sourceKey)
  if (typeof value !== 'string') {
    throw new Error(`en.json has no string entry for ${key}`)
  }
  return value
}

function protectedMarkup(value) {
  return [...value.matchAll(/<\/?[a-z][^>]*>|`[^`\n]+`|\]\(([^)]+)\)|https?:\/\/[^\s<>"`]+/gi)]
    .map(([match]) => (match.startsWith('http') ? match.replace(/[.,;!?]+$/, '') : match))
    .sort()
    .join('|')
}

function balancedMarkup(value) {
  const stack = []
  for (const [tag, closing, name] of value.matchAll(/<(\/?)([a-z][\w-]*)\b[^>]*>/gi)) {
    if (tag.endsWith('/>') || ['br', 'hr', 'img', 'input', 'meta', 'link'].includes(name)) {
      continue
    }
    if (closing) {
      if (stack.pop() !== name) {
        return false
      }
    } else {
      stack.push(name)
    }
  }
  return stack.length === 0
}

export async function applyTranslationDelta(root, translationsPath) {
  const translations = JSON.parse(await fs.readFile(translationsPath, 'utf8'))
  const enCatalog = JSON.parse(await fs.readFile(path.join(root, LOCALES_DIR, 'en.json'), 'utf8'))
  const enEntries = flattenCatalogEntries(enCatalog)

  for (const [locale, entries] of Object.entries(translations)) {
    // Why: the locale becomes a path segment, so an unchecked key could write outside LOCALES_DIR.
    if (!SUPPORTED_LOCALES.has(locale)) {
      throw new Error(`Unsupported locale: ${locale}`)
    }
    const localePath = path.join(root, LOCALES_DIR, `${locale}.json`)
    const localeCatalog = JSON.parse(await fs.readFile(localePath, 'utf8'))
    let added = 0
    let skipped = 0
    for (const [key, entry] of Object.entries(entries)) {
      const enValue = getEn(enEntries, locale, key)
      const rawValue = typeof entry === 'string' ? entry : entry?.translation
      if (locale === 'ru' && (typeof entry !== 'object' || entry?.source !== enValue)) {
        throw new Error(`[${locale}] current English source required for ${key}`)
      }
      if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
        throw new Error(`[${locale}] empty translation for ${key}`)
      }
      const existing = getEntry(localeCatalog, key)
      if (existing !== undefined) {
        if (locale === 'ru' && typeof entry === 'object' && 'previousTranslation' in entry) {
          if (entry.previousTranslation !== existing) {
            throw new Error(`[${locale}] translation changed since review for ${key}`)
          }
        } else {
          console.log(`[${locale}] already present, skip: ${key}`)
          skipped += 1
          continue
        }
      }
      if (placeholders(enValue) !== placeholders(rawValue)) {
        throw new Error(
          `[${locale}] placeholder mismatch for ${key}: en=${placeholders(enValue)} vs locale=${placeholders(rawValue)}`
        )
      }
      if (
        locale === 'ru' &&
        (protectedMarkup(enValue) !== protectedMarkup(rawValue) ||
          (balancedMarkup(enValue) && !balancedMarkup(rawValue)))
      ) {
        throw new Error(`[${locale}] protected markup mismatch for ${key}`)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await applyTranslationDelta(process.cwd(), process.argv[2] ?? '/tmp/translations.json')
}
