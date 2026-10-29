import { getSystemLanguageDetection } from './system-language'
import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'

import {
  resolvePluralFamilyKey,
  withPluralCategoriesFromOther
} from '../../shared/i18n-plural-family'
import { isPseudoLocalizationLocale, pseudoLocalizeString } from '../../shared/pseudo-localization'
import { DEFAULT_UI_LOCALE, resolveUiLocale, type SupportedUiLocale } from '../../shared/ui-locale'
import { UI_LANGUAGE_SYSTEM, type UiLanguage } from '../../shared/ui-language'
import type { PluginLanguagePackRegistration } from '../../shared/plugins/plugin-language-pack-artifact'
import { replacePluginLanguagePackResources } from '../../shared/plugins/plugin-language-pack-i18n-resources'

export const mainI18n: I18nInstance = i18next.createInstance()

let languageGeneration = 0
let pluginLanguagePacks: readonly PluginLanguagePackRegistration[] = []

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

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const loader = LAZY_LOCALE_LOADERS[language as Exclude<SupportedUiLocale, 'en'>]
    if (!loader) {
      // English comes from translateMain defaultValue fallbacks.
      callback(null, false)
      return
    }
    loader().then(
      (mod) =>
        callback(
          null,
          withPluralCategoriesFromOther(
            mod.default,
            new Intl.PluralRules(language).resolvedOptions().pluralCategories
          )
        ),
      (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
    )
  }
}

export function getMainSystemLocale(): string {
  return getSystemLanguageDetection()?.locale ?? DEFAULT_UI_LOCALE
}

// In-memory resources make init synchronous, so startup dialogs can translate before settings load.
void mainI18n.use(lazyLocaleBackend).init({
  fallbackLng: DEFAULT_UI_LOCALE,
  lng: DEFAULT_UI_LOCALE,
  // Keep zh-Hant from falling back to Simplified zh before English.
  load: 'currentOnly',
  // Seed English as loaded; partialBundledLanguages allows lazy non-English catalogs.
  partialBundledLanguages: true,
  resources: {
    en: {
      translation: {}
    }
  },
  // An empty catalog value falls back to English instead of rendering blank.
  returnEmptyString: false,
  interpolation: {
    escapeValue: false
  }
})

export async function setMainUiLanguage(language: UiLanguage): Promise<string> {
  const request = ++languageGeneration
  const selectedLocale = resolveUiLocale(
    language,
    language === UI_LANGUAGE_SYSTEM ? getMainSystemLocale() : DEFAULT_UI_LOCALE
  )
  const locale =
    pluginLanguagePacks.find((pack) => pack.id === selectedLocale)?.resourceLanguage ??
    (selectedLocale.startsWith('plugin:') ? DEFAULT_UI_LOCALE : selectedLocale)
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

export function setMainPluginLanguagePacks(
  packs: readonly PluginLanguagePackRegistration[]
): boolean {
  if (pluginLanguagePacks === packs) {
    return false
  }
  replacePluginLanguagePackResources(mainI18n, pluginLanguagePacks, packs)
  pluginLanguagePacks = packs
  return true
}

export function translateMain(key: string, fallback: string, options?: TOptions): string {
  const value = mainI18n.t(resolvePluralFamilyKey(key, options), {
    defaultValue: fallback,
    ...options
  })
  return isPseudoLocalizationLocale(mainI18n.language) ? pseudoLocalizeString(value) : value
}
