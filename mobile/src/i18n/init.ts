// Why: mobile i18n references the desktop's translation catalog directly via
// Metro watchFolders — no duplication, single source of truth for zh strings.
// init() is idempotent: calling initI18n twice returns the same instance so
// React strict-mode double-invocation is safe.
import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import * as Localization from 'expo-localization'

import zh from '../../../src/renderer/src/i18n/locales/zh.json'
import en from '../../../src/renderer/src/i18n/locales/en.json'

export type MobileUiLanguage = 'system' | 'en' | 'zh'
export type MobileResolvedLanguage = 'en' | 'zh'

const FALLBACK_LANGUAGE: MobileResolvedLanguage = 'en'

export function resolveSystemLanguage(): MobileResolvedLanguage {
  try {
    const locales = Localization.getLocales?.()
    const primary = locales?.[0]
    const code = primary?.languageCode
    const tag = primary?.languageTag?.toLowerCase()
    // Match zh and any zh-* variant (zh-CN, zh-TW, zh-Hans, zh-Hant). The languageTag
    // fallback handles SDKs that don't normalize the primary code.
    if (code === 'zh' || tag?.startsWith('zh')) {
      return 'zh'
    }
    return FALLBACK_LANGUAGE
  } catch {
    return FALLBACK_LANGUAGE
  }
}

export function resolveLanguage(lang: MobileUiLanguage): MobileResolvedLanguage {
  if (lang === 'zh') {
    return 'zh'
  }
  if (lang === 'en') {
    return 'en'
  }
  return resolveSystemLanguage()
}

let instance: I18nInstance | null = null

export async function initI18n(language: MobileUiLanguage): Promise<I18nInstance> {
  // Why: single-caller contract — _layout.tsx is the only invoker at boot,
  // so this short-circuit is sufficient. A concurrent caller would race past
  // the guard and trip i18next's "already initialized" error.
  if (instance) {
    return instance
  }
  const resolved = resolveLanguage(language)
  instance = i18next.createInstance()
  await instance.use(initReactI18next).init({
    lng: resolved,
    fallbackLng: FALLBACK_LANGUAGE,
    defaultNS: 'translation',
    interpolation: { escapeValue: false },
    returnEmptyString: false,
    resources: {
      zh: { translation: zh },
      en: { translation: en }
    }
  })
  return instance
}

export function getI18n(): I18nInstance {
  if (!instance) {
    throw new Error('i18n not initialized — call initI18n() first')
  }
  return instance
}
