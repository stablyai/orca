import { afterEach, describe, expect, it } from 'vitest'

import {
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

describe('mobile i18n', () => {
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

  it('selects the first supported locale from the ordered preferences', () => {
    expect(selectPreferredMobileUiLocale(['fr-FR', 'es-MX'])).toBe('es')
    expect(selectPreferredMobileUiLocale(['zh-Hant', 'ja-JP'])).toBe('ja')
    expect(selectPreferredMobileUiLocale(['zh-MO', 'ko-KR'])).toBe('ko')
  })

  it('reloads only when the effective locale changes', () => {
    expect(shouldReloadForMobileLocaleChange('en', ['fr-FR', 'es-MX'])).toBe(true)
    expect(shouldReloadForMobileLocaleChange('es', ['fr-FR', 'es-MX'])).toBe(false)
  })

  it('reads and interpolates the English catalog', async () => {
    await mobileI18n.changeLanguage('en')
    expect(t('m.rOYT-0U', { value0: 'Camera' })).toBe('Allow Camera?')
  })
})
