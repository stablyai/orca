import { app } from 'electron'
import i18next, { type i18n as I18nInstance, type TOptions } from 'i18next'

import en from '../../renderer/src/i18n/locales/en.json'
import es from '../../renderer/src/i18n/locales/es.json'
import ja from '../../renderer/src/i18n/locales/ja.json'
import ko from '../../renderer/src/i18n/locales/ko.json'
import zh from '../../renderer/src/i18n/locales/zh.json'
import { isPseudoLocalizationLocale, pseudoLocalizeString } from '../../shared/pseudo-localization'
import { DEFAULT_UI_LOCALE, resolveUiLocale, type SupportedUiLocale } from '../../shared/ui-locale'
import { UI_LANGUAGE_SYSTEM, type UiLanguage } from '../../shared/ui-language'

export const mainI18n: I18nInstance = i18next.createInstance()

let initialized = false

export function getMainSystemLocale(): string {
  try {
    return app.getLocale()
  } catch {
    return DEFAULT_UI_LOCALE
  }
}

export async function ensureMainI18n(): Promise<I18nInstance> {
  if (!initialized) {
    await mainI18n.init({
      fallbackLng: DEFAULT_UI_LOCALE,
      lng: DEFAULT_UI_LOCALE,
      resources: {
        en: {
          translation: en
        },
        zh: {
          translation: zh
        },
        ko: {
          translation: ko
        },
        ja: {
          translation: ja
        },
        es: {
          translation: es
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
