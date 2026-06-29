import { describe, expect, it, vi } from 'vitest'
import * as Localization from 'expo-localization'

import { initI18n, resolveLanguage } from '../init'

vi.mock('expo-localization', () => ({
  getLocales: vi.fn()
}))

describe('resolveLanguage', () => {
  it('returns "zh" when explicitly requested', () => {
    expect(resolveLanguage('zh')).toBe('zh')
  })

  it('returns "en" when explicitly requested', () => {
    expect(resolveLanguage('en')).toBe('en')
  })

  it('returns "zh" in system mode when device language is zh', () => {
    vi.mocked(Localization.getLocales).mockReturnValue([
      {
        languageCode: 'zh',
        languageTag: 'zh-CN',
        regionCode: 'CN',
        textDirection: 'ltr',
        decimalSeparator: '.',
        digitGroupingSeparator: ','
      }
    ] as unknown as Parameters<typeof Localization.getLocales>[0])
    expect(resolveLanguage('system')).toBe('zh')
  })

  it('returns "zh" in system mode when device tag is zh-TW', () => {
    vi.mocked(Localization.getLocales).mockReturnValue([
      {
        languageCode: 'zh',
        languageTag: 'zh-TW',
        regionCode: 'TW',
        textDirection: 'ltr',
        decimalSeparator: '.',
        digitGroupingSeparator: ','
      }
    ] as unknown as Parameters<typeof Localization.getLocales>[0])
    expect(resolveLanguage('system')).toBe('zh')
  })

  it('returns "en" in system mode when device language is not zh', () => {
    vi.mocked(Localization.getLocales).mockReturnValue([
      {
        languageCode: 'en',
        languageTag: 'en-US',
        regionCode: 'US',
        textDirection: 'ltr',
        decimalSeparator: '.',
        digitGroupingSeparator: ','
      }
    ] as unknown as Parameters<typeof Localization.getLocales>[0])
    expect(resolveLanguage('system')).toBe('en')
  })

  it('returns "en" in system mode when Localization throws', () => {
    vi.mocked(Localization.getLocales).mockImplementation(() => {
      throw new Error('not available')
    })
    expect(resolveLanguage('system')).toBe('en')
  })
})

describe('initI18n', () => {
  it('initializes with the requested language', async () => {
    const i18n = await initI18n('zh')
    expect(i18n.language).toBe('zh')
  })

  it('initializes with the resolved system language', async () => {
    vi.mocked(Localization.getLocales).mockReturnValue([
      {
        languageCode: 'zh',
        languageTag: 'zh-CN',
        regionCode: 'CN',
        textDirection: 'ltr',
        decimalSeparator: '.',
        digitGroupingSeparator: ','
      }
    ] as unknown as Parameters<typeof Localization.getLocales>[0])
    const i18n = await initI18n('system')
    expect(i18n.language).toBe('zh')
  })

  it('returns the same instance on repeated calls', async () => {
    const a = await initI18n('en')
    const b = await initI18n('zh')
    expect(a).toBe(b)
  })

  // F11: getI18n() is safe to call from any code path — it throws a
  // descriptive error rather than returning a half-initialized instance.
  // The translate() function uses try/catch around getI18n() so a screen
  // mounted before init() resolves (or after a failed init) still renders
  // the fallback string rather than crashing.
  it('translate() returns the fallback when i18n is not initialized', async () => {
    // Why: a screen rendered by a deep link that lands before
    // _layout.tsx has finished its init effect must not crash.
    vi.resetModules()
    const { translate: freshTranslate } = await import('../translate')
    expect(freshTranslate('mobile.settings.title', 'Settings')).toBe('Settings')
  })
})
