import { getLocales } from 'expo-localization'
import i18next, { type i18n as I18nInstance, type TOptions } from 'i18next'

import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

export const MOBILE_UI_LOCALES = ['en', 'zh', 'ko', 'ja', 'es'] as const
export type MobileUiLocale = (typeof MOBILE_UI_LOCALES)[number]

export const DEFAULT_MOBILE_UI_LOCALE: MobileUiLocale = 'en'

export function matchMobileUiLocale(locale: string | undefined): MobileUiLocale | null {
  const tag = (locale ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (!tag) {
    return null
  }
  const primary = tag.split('-')[0]
  if (primary === 'zh') {
    return tag.startsWith('zh-tw') ||
      tag.startsWith('zh-hk') ||
      tag.startsWith('zh-mo') ||
      tag.startsWith('zh-hant')
      ? null
      : 'zh'
  }
  return MOBILE_UI_LOCALES.includes(primary as MobileUiLocale) ? (primary as MobileUiLocale) : null
}

export function normalizeMobileUiLocale(locale: string | undefined): MobileUiLocale {
  return matchMobileUiLocale(locale) ?? DEFAULT_MOBILE_UI_LOCALE
}

export function selectPreferredMobileUiLocale(languageTags: readonly string[]): MobileUiLocale {
  for (const languageTag of languageTags) {
    const locale = matchMobileUiLocale(languageTag)
    if (locale) {
      return locale
    }
  }
  return DEFAULT_MOBILE_UI_LOCALE
}

export function shouldReloadForMobileLocaleChange(
  activeLocale: MobileUiLocale,
  languageTags: readonly string[]
): boolean {
  return selectPreferredMobileUiLocale(languageTags) !== activeLocale
}

export function getMobileSystemLocale(): MobileUiLocale {
  return selectPreferredMobileUiLocale(getLocales().map((locale) => locale.languageTag))
}

export const mobileI18n: I18nInstance = i18next.createInstance()

void mobileI18n.init({
  fallbackLng: DEFAULT_MOBILE_UI_LOCALE,
  lng: getMobileSystemLocale(),
  initAsync: false,
  resources: {
    en: { translation: en },
    es: { translation: es },
    ja: { translation: ja },
    ko: { translation: ko },
    zh: { translation: zh }
  },
  interpolation: {
    escapeValue: false
  }
})

export function t(key: string, options?: TOptions): string {
  return mobileI18n.t(key, options)
}
