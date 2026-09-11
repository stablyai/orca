import { getLocales } from 'expo-localization'
import i18next, { type i18n as I18nInstance, type Resource, type TOptions } from 'i18next'

import en from './locales/en.json'

export const MOBILE_UI_LOCALES = ['en', 'zh', 'ko', 'ja', 'es'] as const
export type MobileUiLocale = (typeof MOBILE_UI_LOCALES)[number]

export const DEFAULT_MOBILE_UI_LOCALE: MobileUiLocale = 'en'

type TranslationCatalog = Record<string, unknown>

// Why: a locale change restarts the app (see use-mobile-locale-reload), so exactly
// one non-fallback catalog is ever live in a given run. Registering every locale
// eagerly would parse four unused catalogs on each cold boot for no benefit. Metro
// still bundles their bytes — unavoidable in React Native, and not worth fighting —
// but nothing evaluates them.
//
// Only English exists today. A locale that matches but has no catalog renders
// English, which is the documented fallback; string extraction adds the rest here.
const MOBILE_LOCALE_CATALOGS: Partial<Record<MobileUiLocale, () => TranslationCatalog>> = {
  en: () => en
}

export function matchMobileUiLocale(locale: string | undefined): MobileUiLocale | null {
  const tag = (locale ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (!tag) {
    return null
  }
  const primary = tag.split('-')[0]
  // Why: the canonical algorithm narrows a tag by stripping subtags, which would
  // resolve zh-Hant-TW to zh and serve Simplified Chinese to a Traditional reader.
  // That is a script difference, not a regional one, so English is the better
  // fallback until a Traditional catalog exists as its own locale.
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

export function loadMobileLocaleCatalog(locale: MobileUiLocale): TranslationCatalog | undefined {
  return MOBILE_LOCALE_CATALOGS[locale]?.()
}

function buildInitialResources(activeLocale: MobileUiLocale): Resource {
  const resources: Resource = {}
  for (const locale of new Set([DEFAULT_MOBILE_UI_LOCALE, activeLocale])) {
    const catalog = loadMobileLocaleCatalog(locale)
    if (catalog) {
      resources[locale] = { translation: catalog }
    }
  }
  return resources
}

const initialLocale = getMobileSystemLocale()

export const mobileI18n: I18nInstance = i18next.createInstance()

void mobileI18n.init({
  fallbackLng: DEFAULT_MOBILE_UI_LOCALE,
  lng: initialLocale,
  initAsync: false,
  resources: buildInitialResources(initialLocale),
  interpolation: {
    escapeValue: false
  }
})

// Why: production never switches locale in place — the app restarts — but tests and
// any future in-process switch still need the catalog present before the first read.
mobileI18n.on('languageChanged', (next) => {
  const locale = normalizeMobileUiLocale(next)
  if (mobileI18n.hasResourceBundle(locale, 'translation')) {
    return
  }
  const catalog = loadMobileLocaleCatalog(locale)
  if (catalog) {
    mobileI18n.addResourceBundle(locale, 'translation', catalog)
  }
})

export function t(key: string, options?: TOptions): string {
  return mobileI18n.t(key, options)
}

export function getActiveMobileUiLanguageTag(): string {
  const locale = normalizeMobileUiLocale(mobileI18n.language)
  return locale === 'zh' ? 'zh-Hans' : locale
}

export function createMobileTranslator(keyPrefix: string) {
  return (key: string, options?: TOptions): string => t(`${keyPrefix}.${key}`, options)
}
