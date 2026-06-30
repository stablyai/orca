import { app } from 'electron'
import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'

import en from '../../renderer/src/i18n/locales/en.json'
import { isPseudoLocalizationLocale, pseudoLocalizeString } from '../../shared/pseudo-localization'
import { DEFAULT_UI_LOCALE, resolveUiLocale, type SupportedUiLocale } from '../../shared/ui-locale'
import { UI_LANGUAGE_SYSTEM, type UiLanguage } from '../../shared/ui-language'

export const mainI18n: I18nInstance = i18next.createInstance()

let initialized = false

// Why: only the English catalog is bundled eagerly. The other four locales add
// ~1.7MB to the main-process bundle (parsed before the first window opens) even
// though the menu/tray/dialog strings are rendered after i18n init is awaited.
// A lazy backend fetches each non-English catalog on demand, so changeLanguage()
// loads its bundle instead of paying the parse cost at cold start. Safe because
// ensureMainI18n() and setMainUiLanguage() are awaited before any menu builds
// (index.ts whenReady), so the active locale is resolved before it is read.
const NON_DEFAULT_LOCALE_LOADERS: Record<
  Exclude<SupportedUiLocale, 'en'>,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  es: () => import('../../renderer/src/i18n/locales/es.json'),
  ja: () => import('../../renderer/src/i18n/locales/ja.json'),
  ko: () => import('../../renderer/src/i18n/locales/ko.json'),
  zh: () => import('../../renderer/src/i18n/locales/zh.json')
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const loader = NON_DEFAULT_LOCALE_LOADERS[language as Exclude<SupportedUiLocale, 'en'>]
    if (!loader) {
      // English (and unknown locales) are served from bundled resources; signal
      // "nothing to load" so i18next falls back to the in-memory catalog.
      callback(null, false)
      return
    }
    loader().then(
      (mod) => callback(null, mod.default),
      (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
    )
  }
}

export function getMainSystemLocale(): string {
  try {
    return app.getLocale()
  } catch {
    return DEFAULT_UI_LOCALE
  }
}

export async function ensureMainI18n(): Promise<I18nInstance> {
  if (!initialized) {
    await mainI18n.use(lazyLocaleBackend).init({
      fallbackLng: DEFAULT_UI_LOCALE,
      lng: DEFAULT_UI_LOCALE,
      // Why: `resources` seeds the eager English catalog while
      // `partialBundledLanguages` lets the backend supply the lazy locales — so
      // i18next uses bundled `en` immediately and only hits the backend for the
      // languages that aren't already in memory.
      partialBundledLanguages: true,
      resources: {
        en: {
          translation: en
        }
      },
      interpolation: {
        escapeValue: false
      }
    })
    initialized = true
  }
  return mainI18n
}

export async function setMainUiLanguage(language: UiLanguage): Promise<SupportedUiLocale> {
  await ensureMainI18n()
  const locale = resolveUiLocale(
    language,
    language === UI_LANGUAGE_SYSTEM ? getMainSystemLocale() : DEFAULT_UI_LOCALE
  )
  if (mainI18n.language !== locale) {
    // changeLanguage triggers the lazy backend load for non-English locales and
    // resolves once the catalog is in memory, so callers that await this have
    // the translations ready before they render menus/dialogs.
    await mainI18n.changeLanguage(locale)
  }
  return locale
}

export function translateMain(key: string, fallback: string, options?: TOptions): string {
  // Why: menu registration can run before async init finishes in tests; fall back
  // to the English default instead of returning undefined from an uninitialized i18n.
  const raw = initialized ? mainI18n.t(key, { defaultValue: fallback, ...options }) : fallback
  const value = typeof raw === 'string' && raw.length > 0 ? raw : fallback
  return isPseudoLocalizationLocale(mainI18n.language) ? pseudoLocalizeString(value) : value
}
