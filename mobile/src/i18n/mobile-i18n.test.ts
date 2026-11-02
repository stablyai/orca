import { beforeEach, describe, expect, it, vi } from 'vitest'

const pending = new Map<string, (catalog: Record<string, unknown>) => void>()
const failing = new Set<string>()

vi.mock('./locale-catalog-imports', () => ({
  importLocaleCatalog: (locale: string) =>
    failing.has(locale)
      ? Promise.reject(new Error('missing chunk'))
      : new Promise((resolve) => pending.set(locale, resolve))
}))

const { activateMobileUiLocale, getMobileUiLocale, mobileI18n, translate } =
  await import('./mobile-i18n')

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('activateMobileUiLocale', () => {
  beforeEach(async () => {
    pending.clear()
    failing.clear()
    await activateMobileUiLocale('en')
  })

  it('keeps the latest choice when an older catalog import settles last', async () => {
    const french = activateMobileUiLocale('fr')
    const japanese = activateMobileUiLocale('ja')
    pending.get('ja')?.({ greeting: 'こんにちは' })
    await japanese
    pending.get('fr')?.({ greeting: 'Bonjour' })
    await french
    expect(getMobileUiLocale()).toBe('ja')
    expect(mobileI18n.language).toBe('ja')
    expect(translate('greeting', 'Hello')).toBe('こんにちは')
  })

  it('falls back to English when a catalog cannot load', async () => {
    failing.add('de')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await activateMobileUiLocale('de')
    expect(getMobileUiLocale()).toBe('en')
    expect(translate('greeting', 'Hello')).toBe('Hello')
  })

  it('picks CLDR plural forms and English fallbacks for missing keys', async () => {
    const russian = activateMobileUiLocale('ru')
    await settle()
    pending.get('ru')?.({
      files_one: '{{count}} файл',
      files_few: '{{count}} файла',
      files_many: '{{count}} файлов'
    })
    await russian
    expect(
      [1, 3, 5, 21].map((count) => translate('files_one', '{{count}} file', { count }))
    ).toEqual(['1 файл', '3 файла', '5 файлов', '21 файл'])
    expect(translate('untranslated', 'Still English')).toBe('Still English')
  })
})
