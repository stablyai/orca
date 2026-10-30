import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPreferredSystemLanguages, isReady } = vi.hoisted(() => ({
  getPreferredSystemLanguages: vi.fn(),
  isReady: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages, isReady } }))

beforeEach(() => {
  vi.resetModules()
  isReady.mockReturnValue(true)
  getPreferredSystemLanguages.mockReturnValue(['fr-FR', 'en-US'])
})

describe('native language snapshot', () => {
  it('reads preferences once after app readiness and shares the ordered result', async () => {
    const { getSystemLanguageDetection } = await import('./system-language')
    isReady.mockReturnValue(false)
    getPreferredSystemLanguages.mockReturnValueOnce(['ja-JP'])
    // Pre-ready reads serve startup-failure dialogs without pinning the post-ready snapshot.
    expect(getSystemLanguageDetection()?.locale).toBe('ja')
    isReady.mockReturnValue(true)
    expect(getSystemLanguageDetection()).toMatchObject({
      detectedTag: 'fr-FR',
      locale: 'fr',
      source: 'native'
    })
    getPreferredSystemLanguages.mockReturnValue(['en-US'])
    expect(getSystemLanguageDetection()?.locale).toBe('fr')
    expect(getPreferredSystemLanguages).toHaveBeenCalledTimes(2)
  })

  it('keeps a C-only native result unknown so Chromium cannot override it', async () => {
    getPreferredSystemLanguages.mockReturnValue(['C.UTF-8', 'POSIX'])
    const { getSystemLanguageDetection } = await import('./system-language')
    expect(getSystemLanguageDetection()).toMatchObject({ status: 'unknown', source: 'native' })
  })

  it.each(['empty', 'failed'])(
    'permits uncertain browser fallback for %s native lookup',
    async (kind) => {
      getPreferredSystemLanguages.mockImplementation(() => {
        if (kind === 'failed') {
          throw new Error('Unavailable')
        }
        return []
      })
      const { getSystemLanguageDetection } = await import('./system-language')
      expect(getSystemLanguageDetection()).toBeNull()
      const fallback = getSystemLanguageDetection(['fr-FR'])
      expect(fallback).toMatchObject({ locale: 'fr', source: 'browser-fallback' })
      expect(getSystemLanguageDetection(['ja-JP'])).toBe(fallback)
      const { getMainSystemLocale, setMainUiLanguage, mainI18n } = await import('./main-i18n')
      expect(getMainSystemLocale()).toBe('fr')
      await setMainUiLanguage('system')
      expect(mainI18n.language).toBe('fr')
      await setMainUiLanguage('en')
      expect(mainI18n.language).toBe('en')
    }
  )

  it('never replaces a successful native snapshot with browser fallback hints', async () => {
    const { getSystemLanguageDetection } = await import('./system-language')
    const native = getSystemLanguageDetection()
    expect(getSystemLanguageDetection(['ja-JP'])).toBe(native)
    expect(native).toMatchObject({ locale: 'fr', source: 'native' })
  })
})

it.each([
  { platform: 'Windows', preferences: ['ja-JP', 'en-US'], locale: 'ja', status: 'supported' },
  { platform: 'macOS', preferences: ['fr-US', 'en-US'], locale: 'fr', status: 'supported' },
  {
    platform: 'Linux',
    preferences: ['zh_CN.UTF-8', 'zh_CN', 'zh', 'C'],
    locale: 'zh',
    status: 'supported'
  },
  { platform: 'Linux C-only', preferences: ['C.UTF-8', 'C'], locale: 'en', status: 'unknown' },
  { platform: 'unsupported', preferences: ['it-IT', 'fr-FR'], locale: 'en', status: 'unsupported' }
])('handles $platform preference lists', async ({ preferences, locale, status }) => {
  getPreferredSystemLanguages.mockReturnValue(preferences)
  const { getSystemLanguageDetection } = await import('./system-language')
  expect(getSystemLanguageDetection()).toMatchObject({ locale, status })
})
