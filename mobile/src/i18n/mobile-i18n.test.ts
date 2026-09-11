import { afterEach, describe, expect, it } from 'vitest'

import {
  createMobileTranslator,
  getActiveMobileUiLanguageTag,
  getMobileSystemLocale,
  loadMobileLocaleCatalog,
  matchMobileUiLocale,
  mobileI18n,
  normalizeMobileUiLocale,
  selectPreferredMobileUiLocale,
  shouldReloadForMobileLocaleChange,
  t,
  type MobileUiLocale
} from './mobile-i18n'

const INITIAL_LOCALE = mobileI18n.language

afterEach(async () => {
  await mobileI18n.changeLanguage(INITIAL_LOCALE)
})

describe('mobile i18n locale matching', () => {
  it.each([
    ['es-MX', 'es'],
    ['ja-JP', 'ja'],
    ['ko_KR', 'ko'],
    ['zh-Hans-CN', 'zh'],
    ['zh-Hant-TW', 'en'],
    ['zh-MO', 'en'],
    ['fr-FR', 'en']
  ] satisfies [string, MobileUiLocale][])('normalizes %s to %s', (input, expected) => {
    expect(normalizeMobileUiLocale(input)).toBe(expected)
  })

  // Traditional Chinese is a script difference, not a regional one, so it must not
  // narrow to Simplified the way tag-stripping would. English is the fallback until
  // a Traditional catalog exists as its own locale.
  it.each(['zh-Hant', 'zh-Hant-TW', 'zh-TW', 'zh-HK', 'zh-MO', 'ZH_HANT_HK'])(
    'refuses to serve Simplified Chinese for %s',
    (tag) => {
      expect(matchMobileUiLocale(tag)).toBeNull()
      expect(normalizeMobileUiLocale(tag)).toBe('en')
    }
  )

  it.each(['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG'])('serves Simplified for %s', (tag) => {
    expect(matchMobileUiLocale(tag)).toBe('zh')
  })

  it('treats unmatched and empty tags as unsupported', () => {
    expect(matchMobileUiLocale('fr-FR')).toBeNull()
    expect(matchMobileUiLocale('')).toBeNull()
    expect(matchMobileUiLocale('   ')).toBeNull()
    expect(matchMobileUiLocale(undefined)).toBeNull()
  })

  it('selects the first supported locale from the ordered preferences', () => {
    expect(selectPreferredMobileUiLocale(['fr-FR', 'es-MX'])).toBe('es')
    expect(selectPreferredMobileUiLocale(['zh-Hant', 'ja-JP'])).toBe('ja')
    expect(selectPreferredMobileUiLocale(['zh-MO', 'ko-KR'])).toBe('ko')
    expect(selectPreferredMobileUiLocale([])).toBe('en')
  })

  it('reloads only when the effective locale changes', () => {
    expect(shouldReloadForMobileLocaleChange('en', ['fr-FR', 'es-MX'])).toBe(true)
    expect(shouldReloadForMobileLocaleChange('es', ['fr-FR', 'es-MX'])).toBe(false)
    // zh-Hant resolves to English, so an English session must not churn a reload.
    expect(shouldReloadForMobileLocaleChange('en', ['zh-Hant-TW'])).toBe(false)
  })

  it('exposes the effective BCP 47 language tag for embedded documents', async () => {
    await mobileI18n.changeLanguage('zh')
    expect(getActiveMobileUiLanguageTag()).toBe('zh-Hans')
  })
})

describe('mobile i18n startup', () => {
  it('boots against the device locale read at module scope', () => {
    // The vitest stub reports 'en'; this pins that startup reads the device at all.
    expect(getMobileSystemLocale()).toBe('en')
    expect(mobileI18n.language).toBe('en')
    expect(mobileI18n.isInitialized).toBe(true)
  })

  // Coverage, not a regression guard: with only en.json present, registering every
  // supported locale produces the same result as registering the active one, so this
  // cannot distinguish the two. It pins that a supported locale without a catalog is
  // never registered. Extraction adds a second catalog, which is what finally makes
  // the lazy path observable.
  it('never registers a supported locale that has no catalog', () => {
    expect(mobileI18n.hasResourceBundle('en', 'translation')).toBe(true)
    for (const locale of ['es', 'ja', 'ko', 'zh'] satisfies MobileUiLocale[]) {
      expect(loadMobileLocaleCatalog(locale)).toBeUndefined()
      expect(mobileI18n.hasResourceBundle(locale, 'translation')).toBe(false)
    }
  })

  it('renders a matched locale in English while its catalog is missing', async () => {
    await mobileI18n.changeLanguage('es')
    expect(mobileI18n.hasResourceBundle('es', 'translation')).toBe(false)
    expect(t('someKey')).toBe('someKey')
  })

  it('wires translation lookup without shipping any strings yet', () => {
    expect(loadMobileLocaleCatalog('en')).toEqual({})
    expect(t('unknown.key')).toBe('unknown.key')
    expect(createMobileTranslator('task')('gitHub')).toBe('task.gitHub')
  })
})
