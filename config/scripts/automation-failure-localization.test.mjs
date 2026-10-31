import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { collectLocalizationKeyReferences } from './verify-localization-catalog.mjs'
import {
  collectRuntimeRequiredCatalogProblems,
  collectRuntimeRequiredKeys
} from './generate-runtime-required-english-catalog.mjs'

it('ships the badge reference, English runtime plurals and each locale’s complete CLDR family', () => {
  const root = resolve(import.meta.dirname, '../..')
  const source = resolve(root, 'src/renderer/src/components/sidebar/AutomationFailureBadge.tsx')
  const references = collectLocalizationKeyReferences(source, readFileSync(source, 'utf8'), root)
  expect(references.some(({ key }) => key.startsWith('automations.unseenFailures'))).toBe(true)
  const directory = resolve(root, 'src/renderer/src/i18n/locales')
  const read = (path) => JSON.parse(readFileSync(path, 'utf8')).automations
  const english = read(resolve(directory, 'en.json'))
  const entries = new Map(
    Object.entries(english)
      .filter(([key]) => key.startsWith('unseenFailures'))
      .map(([key, value]) => [`automations.${key}`, value])
  )
  for (const { key } of references) {
    expect(entries.has(key), key).toBe(true)
  }
  expect(entries.get('automations.unseenFailures_one')).toBe('{{count}} unseen failed runs')
  expect(entries.get('automations.unseenFailures_other')).toBe('{{count}} unseen failed runs')
  const runtime = read(resolve(root, 'src/renderer/src/i18n/en-runtime-required.json'))
  const shipped = new Map(
    Object.entries(runtime)
      .filter(([key]) => key.startsWith('unseenFailures'))
      .map(([key, value]) => [`automations.${key}`, value])
  )
  const problems = collectRuntimeRequiredCatalogProblems(
    entries,
    collectRuntimeRequiredKeys(entries, references),
    shipped
  )
  expect(problems.missing).toEqual([])
  expect(problems.contradicting).toEqual([])
  for (const filename of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const locale = filename.slice(0, -5)
    const catalog = read(resolve(directory, filename))
    expect(catalog.unseenFailures, filename).toContain('{{count}}')
    for (const form of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
      expect(catalog[`unseenFailures_${form}`], `${locale}/${form}`).toContain('{{count}}')
    }
  }
})
