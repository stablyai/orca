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
})
