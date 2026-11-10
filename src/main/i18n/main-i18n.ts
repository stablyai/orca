import { getSystemLanguageDetection } from './system-language'
import type { i18n as I18nInstance } from 'i18next'

import { createOrcaI18n } from '../../shared/orca-i18n-instance'
import { DEFAULT_UI_LOCALE, resolveUiLocale, type SupportedUiLocale } from '../../shared/ui-locale'
import { UI_LANGUAGE_SYSTEM, type UiLanguage } from '../../shared/ui-language'

let languageGeneration = 0

// English uses caller fallbacks; load only the selected non-English catalog after startup.
const LAZY_LOCALE_LOADERS: Record<
  Exclude<SupportedUiLocale, 'en'>,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  de: () => import('../../renderer/src/i18n/locales/de.json'),
  es: () => import('../../renderer/src/i18n/locales/es.json'),
  fr: () => import('../../renderer/src/i18n/locales/fr.json'),
  ja: () => import('../../renderer/src/i18n/locales/ja.json'),
  ko: () => import('../../renderer/src/i18n/locales/ko.json'),
  pt: () => import('../../renderer/src/i18n/locales/pt.json'),
  ru: () => import('../../renderer/src/i18n/locales/ru.json'),
  tr: () => import('../../renderer/src/i18n/locales/tr.json'),
  zh: () => import('../../renderer/src/i18n/locales/zh.json'),
  'zh-Hant': () => import('../../renderer/src/i18n/locales/zh-Hant.json')
}
const LAZY_LOCALE_LOADER_MAP = new Map<string, () => Promise<{ default: Record<string, unknown> }>>(
  Object.entries(LAZY_LOCALE_LOADERS)
)

// Initializes synchronously, so startup dialogs can translate before settings load.
const orcaI18n = createOrcaI18n({
  loadCatalog: (language) => LAZY_LOCALE_LOADER_MAP.get(language)?.().then((mod) => mod.default),
  englishResources: {}
})

export const mainI18n: I18nInstance = orcaI18n.i18n
export const translateMain = orcaI18n.translate
export const setMainPluginLanguagePacks = orcaI18n.setPluginLanguagePacks

export function getMainSystemLocale(): string {
  return getSystemLanguageDetection()?.locale ?? DEFAULT_UI_LOCALE
}

export async function setMainUiLanguage(language: UiLanguage): Promise<string> {
  const request = ++languageGeneration
  const locale = orcaI18n.resolveResourceLanguage(
    resolveUiLocale(
      language,
      language === UI_LANGUAGE_SYSTEM ? getMainSystemLocale() : DEFAULT_UI_LOCALE
    )
  )
  if (mainI18n.language !== locale) {
    await mainI18n.loadLanguages(locale)
    if (request !== languageGeneration) {
      return mainI18n.language
    }
    await mainI18n.changeLanguage(locale)
  }
  return locale
}

/** Startup failures can show dialogs before settings load; use the system language until then. */
export async function prepareEarlyMainUiLanguage(): Promise<void> {
  if (languageGeneration > 0) {
    return
  }
  try {
    await setMainUiLanguage(UI_LANGUAGE_SYSTEM)
  } catch (error) {
    console.warn('[i18n] Could not localize early startup dialogs:', error)
  }
}
