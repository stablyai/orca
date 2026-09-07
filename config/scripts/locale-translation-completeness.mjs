import fs from 'node:fs/promises'
import path from 'node:path'
import { shouldPreserveEnglishValue } from './locale-translation-policy.mjs'

export function flattenTranslationCatalog(catalog, prefix = '', result = new Map()) {
  if (typeof catalog === 'string') {
    result.set(prefix, catalog)
  } else if (catalog && typeof catalog === 'object' && !Array.isArray(catalog)) {
    for (const [key, value] of Object.entries(catalog)) {
      flattenTranslationCatalog(value, prefix ? `${prefix}.${key}` : key, result)
    }
  }
  return result
}

export function collectTranslationDebt(english, translated, acceptedIdentical = {}) {
  const source = flattenTranslationCatalog(english)
  const target = flattenTranslationCatalog(translated)
  const debt = {}
  for (const [key, value] of [...source].sort(([a], [b]) => a.localeCompare(b))) {
    if (shouldPreserveEnglishValue(value, key) || acceptedIdentical[key] === value) {
      continue
    }
    const localValue = target.get(key)
    if (typeof localValue !== 'string' || localValue.trim() === '') {
      debt[key] = `missing: ${value}`
    } else if (localValue.trim() === value.trim()) {
      debt[key] = `identical: ${value}`
    }
  }
  return debt
}

export function collectTranslationRegressions(debt, baseline, requiredKeys = new Set()) {
  return Object.entries(debt).filter(
    ([key, issue]) => requiredKeys.has(key) || baseline[key] !== issue
  )
}

export function requiredTranslationKeys(references, surface) {
  return new Set(
    references
      .filter(
        ({ filePath, key }) =>
          surface.sourcePrefixes.some((prefix) => filePath.startsWith(prefix)) ||
          surface.keyPrefixes.some((prefix) => key.startsWith(prefix))
      )
      .map(({ key }) => key)
  )
}

export function checkTranslationCompleteness({
  english,
  translated,
  references,
  policy,
  baseline
}) {
  const debt = collectTranslationDebt(english, translated, policy.acceptedIdentical)
  const required = requiredTranslationKeys(references, policy)
  const regressions = collectTranslationRegressions(debt, baseline, required)
  const resolved = Object.keys(baseline).filter((key) => !(key in debt))
  return { debt, regressions, resolved, requiredCount: required.size }
}

export async function createTranslationCompletenessCheck(root, english, references) {
  let policies = {}
  try {
    policies = JSON.parse(
      await fs.readFile(path.join(root, 'config', 'localization-completeness.json'), 'utf8')
    )
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  return async (locale, translated) => {
    if (!policies[locale]) {
      return true
    }
    const baseline = JSON.parse(
      await fs.readFile(path.join(root, 'config', 'localization-debt', `${locale}.json`), 'utf8')
    )
    const result = checkTranslationCompleteness({
      english,
      translated,
      references,
      policy: policies[locale],
      baseline
    })
    console.log(
      `${locale}: ${result.requiredCount} required surface keys; ${Object.keys(result.debt).length} outstanding missing/English-identical entries across the full catalog.`
    )
    if (result.regressions.length > 0) {
      console.error(
        'Translation completeness failed. Translate the entries; do not grow the debt baseline.'
      )
      console.error(result.regressions.map(([key, issue]) => `${key}: ${issue}`).join('\n'))
      return false
    }
    if (result.resolved.length > 0) {
      console.error(
        'Remove resolved entries from the translation debt baseline to prevent regressions:'
      )
      console.error(result.resolved.join('\n'))
      return false
    }
    return true
  }
}
