import { describe, expect, it, vi } from 'vitest'
import * as Localization from 'expo-localization'

import { initI18n, resolveLanguage } from './init'

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
    ] as unknown as Array<{ languageCode: string }>)
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
    ] as unknown as Array<{ languageCode: string }>)
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
    ] as unknown as Array<{ languageCode: string }>)
    const i18n = await initI18n('system')
    expect(i18n.language).toBe('zh')
  })

  it('returns the same instance on repeated calls', async () => {
    const a = await initI18n('en')
    const b = await initI18n('zh')
    expect(a).toBe(b)
  })
})
