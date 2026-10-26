import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { applyTranslationDelta } from './apply-translation-delta.mjs'
import { russianTranslationProgress } from './russian-translation-progress.mjs'

async function fixture(english, russian = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-ru-delta-'))
  const locales = path.join(root, 'src', 'renderer', 'src', 'i18n', 'locales')
  await mkdir(locales, { recursive: true })
  await writeFile(path.join(locales, 'en.json'), JSON.stringify(english))
  const target = path.join(locales, 'ru.json')
  await writeFile(target, JSON.stringify(russian))
  const delta = path.join(root, 'delta.json')
  return { root, target, delta }
}

describe('reviewed Russian translation deltas', () => {
  it('applies current reviewed entries and locale-specific plurals without replacing existing work', async () => {
    const { root, target, delta } = await fixture(
      {
        greeting: 'Hello {{name}}',
        images_one: '{{count}} image',
        images_other: '{{count}} images'
      },
      { greeting: 'Здравствуйте, {{name}}' }
    )
    await writeFile(
      delta,
      JSON.stringify({
        ru: {
          greeting: { source: 'Hello {{name}}', translation: 'Привет, {{name}}' },
          images_many: { source: '{{count}} images', translation: '{{count}} изображений' }
        }
      })
    )
    await applyTranslationDelta(root, delta)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      greeting: 'Здравствуйте, {{name}}',
      images_many: '{{count}} изображений'
    })
  })

  it.each([
    { source: 'Old English {{name}}', translation: 'Привет, {{name}}' },
    { source: 'Hello {{name}}', translation: 'Привет, {{wrongName}}' },
    { source: 'Hello {{name}}', translation: '' },
    'Привет, {{name}}'
  ])(
    'rejects stale, malformed or unreviewed entries without touching the catalog: %j',
    async (entry) => {
      const { root, target, delta } = await fixture({ greeting: 'Hello {{name}}' })
      await writeFile(delta, JSON.stringify({ ru: { greeting: entry } }))
      await expect(applyTranslationDelta(root, delta)).rejects.toThrow()
      expect(await readFile(target, 'utf8')).toBe('{}')
    }
  )

  it('replaces a copied translation only when the reviewed previous value still matches', async () => {
    const { root, target, delta } = await fixture({ first: 'First' }, { first: 'First' })
    const reviewed = { source: 'First', translation: 'Первый', previousTranslation: 'First' }
    await writeFile(delta, JSON.stringify({ ru: { first: reviewed } }))
    await applyTranslationDelta(root, delta)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ first: 'Первый' })
    await expect(applyTranslationDelta(root, delta)).rejects.toThrow(
      'translation changed since review'
    )
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ first: 'Первый' })
  })

  it.each([
    ['Open <settings>Settings</settings>', 'Откройте настройки'],
    [
      'Open <settings><strong>Settings</strong></settings>',
      'Откройте <settings><strong>настройки</settings></strong>'
    ],
    ['Run `orca status`', 'Выполните `orca stop`'],
    ['See https://example.com/docs', 'См. https://example.com/other'],
    ['See https://example.com/docs?q=a#top.', 'См. https://example.com/docs?q=b#top.'],
    ['See [docs](https://example.com/docs)', 'Откройте [документацию](https://example.com/other)']
  ])('preserves protected markup and literal commands in %s', async (source, translation) => {
    const { root, target, delta } = await fixture({ action: source })
    await writeFile(delta, JSON.stringify({ ru: { action: { source, translation } } }))
    await expect(applyTranslationDelta(root, delta)).rejects.toThrow('protected markup mismatch')
    expect(await readFile(target, 'utf8')).toBe('{}')
  })

  it('reports copied source separately and emits only actual missing source entries', () => {
    const report = russianTranslationProgress(
      { first: 'First', second: 'Second', third: 'Third', images_other: '{{count}} images' },
      { first: 'Первый', second: 'Second', images_many: '{{count}} изображений' }
    )
    expect(report.translated).toBe(1)
    expect(report.unchanged).toEqual(['second'])
    expect(report.unreviewedCopies).toEqual(['second'])
    expect(report.missing).toEqual(['third', 'images_other'])
    expect(report.pluralForms).toBe(1)
    expect(report.extra).toEqual([])
    expect(report.domains['navigation-workspace-runtime']).toEqual({
      ru: {
        second: { source: 'Second', translation: '', previousTranslation: 'Second' },
        third: { source: 'Third', translation: '' },
        images_other: { source: '{{count}} images', translation: '' }
      }
    })
  })
})

it('allows punctuation outside an unchanged prose URL to be translated', async () => {
  const source = 'See https://example.com/docs.'
  const translation = 'См. https://example.com/docs!'
  const { root, target, delta } = await fixture({ action: source })
  await writeFile(delta, JSON.stringify({ ru: { action: { source, translation } } }))
  await applyTranslationDelta(root, delta)
  expect(JSON.parse(await readFile(target, 'utf8')).action).toBe(translation)
})

it('applies generated missing plural deltas using each exact English form', async () => {
  const english = { items_one: '{{count}} item', items_other: '{{count}} items' }
  const report = russianTranslationProgress(english, {}, new Set(['items']))
  const entries = report.domains['navigation-workspace-runtime'].ru
  expect(entries.items_one.source).toBe('{{count}} item')
  expect(entries.items_few.source).toBe('{{count}} items')
  const words = {
    items_one: 'элемент',
    items_other: 'элемента',
    items_few: 'элемента',
    items_many: 'элементов'
  }
  const reviewed = Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [
      key,
      { ...entry, translation: `{{count}} ${words[key]}` }
    ])
  )
  const { root, target, delta } = await fixture(english)
  await writeFile(delta, JSON.stringify({ ru: reviewed }))
  await applyTranslationDelta(root, delta)
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
    items_one: '{{count}} элемент',
    items_other: '{{count}} элемента',
    items_few: '{{count}} элемента',
    items_many: '{{count}} элементов'
  })
})
