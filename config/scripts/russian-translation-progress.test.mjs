import { expect, it } from 'vitest'
import { russianTranslationProgress } from './russian-translation-progress.mjs'

it('distinguishes untranslated UI from original product names and executable commands', () => {
  const source = {
    provider: 'Codex',
    command: 'pnpm install',
    website: 'https://example.com',
    button: 'Continue',
    status: 'idle',
    missing: 'Project'
  }
  const { missing: _missing, ...russian } = source
  const progress = russianTranslationProgress(source, russian)
  expect(progress.translated).toBe(0)
  expect(progress.missing).toEqual(['missing'])
  expect(progress.unreviewedCopies).toEqual(['button', 'status'])
  expect(Object.keys(progress.domains['navigation-workspace-runtime'].ru)).toEqual([
    'button',
    'status',
    'missing'
  ])
})

it('binds reviewed technical exceptions to their exact English source', () => {
  const original = { auto: { components: { TaskPage: { '3659f9792a': 'board' } } } }
  expect(russianTranslationProgress(original, original).unreviewedCopies).toEqual([])
  const changed = { auto: { components: { TaskPage: { '3659f9792a': 'Continue' } } } }
  expect(russianTranslationProgress(changed, changed).unreviewedCopies).toEqual([
    'auto.components.TaskPage.3659f9792a'
  ])
})

it('requires Russian categories only for count-resolved source families', () => {
  const english = {
    items_one: '{{count}} item',
    items_other: '{{count}} items',
    found_theme_one: 'Theme found',
    found_theme_other: 'Themes found'
  }
  const russian = {
    items_one: '{{count}} элемент',
    items_other: '{{count}} элемента',
    found_theme_one: 'Найдена тема',
    found_theme_other: 'Найдены темы'
  }
  expect(
    russianTranslationProgress(english, russian, new Set(['items'])).missingPluralForms
  ).toEqual(['items_few', 'items_many'])
  expect(
    russianTranslationProgress(
      english,
      {
        ...russian,
        items_few: '{{count}} элемента',
        items_many: '{{count}} элементов'
      },
      new Set(['items'])
    ).missingPluralForms
  ).toEqual([])
})

it('marks copied additional plural forms as unreviewed and emits a replaceable delta', () => {
  const english = { items_one: '{{count}} item', items_other: '{{count}} items' }
  const russian = {
    items_one: '{{count}} элемент',
    items_other: '{{count}} элемента',
    items_few: '{{count}} items',
    items_many: '{{count}} items'
  }
  const report = russianTranslationProgress(english, russian, new Set(['items']))
  expect(report.unreviewedCopies).toEqual(['items_few', 'items_many'])
  expect(report.domains['navigation-workspace-runtime'].ru.items_few).toEqual({
    source: '{{count}} items',
    translation: '',
    previousTranslation: '{{count}} items'
  })
  expect(
    russianTranslationProgress(
      { providers_other: 'Codex' },
      {
        providers_other: 'Codex',
        providers_one: 'Codex',
        providers_few: 'Codex',
        providers_many: 'Codex'
      },
      new Set(['providers'])
    ).unreviewedCopies
  ).toEqual([])
})
