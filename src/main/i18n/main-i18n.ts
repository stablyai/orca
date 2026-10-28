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

export const mainI18n: I18nInstance = i18next.createInstance()

let initialized = false
let languageGeneration = 0
let pluginLanguagePacks: readonly PluginLanguagePackRegistration[] = []
const registeredPluginLanguages = new Set<string>()

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

export async function ensureMainI18n(): Promise<I18nInstance> {
  if (!initialized) {
    await mainI18n.use(lazyLocaleBackend).init({
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
      interpolation: {
        escapeValue: false
      }
    })
    initialized = true
    applyMainPluginLanguagePacks()
  }
  return mainI18n
}

export async function setMainUiLanguage(language: UiLanguage): Promise<string> {
  const request = ++languageGeneration
  await ensureMainI18n()
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

function applyMainPluginLanguagePacks(): void {
  for (const language of registeredPluginLanguages) {
    mainI18n.removeResourceBundle(language, 'translation')
  }
  registeredPluginLanguages.clear()
  for (const pack of pluginLanguagePacks) {
    mainI18n.addResourceBundle(pack.resourceLanguage, 'translation', pack.catalog, true, true)
    registeredPluginLanguages.add(pack.resourceLanguage)
  }
}

export function setMainPluginLanguagePacks(
  packs: readonly PluginLanguagePackRegistration[]
): boolean {
  if (pluginLanguagePacks === packs) {
    return false
  }
  pluginLanguagePacks = packs
  if (initialized) {
    applyMainPluginLanguagePacks()
  }
  return true
}

export function translateMain(key: string, fallback: string, options?: TOptions): string {
  // Menu registration can precede async initialization; use the English fallback then.
  const raw = initialized
    ? mainI18n.t(resolvePluralFamilyKey(key, options), { defaultValue: fallback, ...options })
    : interpolateFallback(fallback, options)
  const value = typeof raw === 'string' && raw.length > 0 ? raw : fallback
  return isPseudoLocalizationLocale(mainI18n.language) ? pseudoLocalizeString(value) : value
}

// Why: startup dialogs can run before init, and their fallbacks still carry {{placeholders}}.
function interpolateFallback(fallback: string, options: TOptions | undefined): string {
  if (!options) {
    return fallback
  }
  return fallback.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (placeholder, name: string) => {
    const value: unknown = options[name]
    return value === undefined || value === null ? placeholder : String(value)
  })
}
