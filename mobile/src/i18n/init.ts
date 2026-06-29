// Why: mobile i18n references the desktop's translation catalog directly via
// Metro watchFolders — no duplication, single source of truth for zh strings.
// init() is idempotent: calling initI18n twice returns the same instance so
// React strict-mode double-invocation is safe.
//
// init is also atomic: if the underlying i18next.init() rejects, we do NOT
// store the partially-created instance. Subsequent getI18n() calls then
// throw a descriptive error (caught by _layout.tsx) instead of silently
// returning a half-initialized object that would crash later at first t().
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
    const primary = locales?.[0]?.languageCode
    return primary === 'zh' ? 'zh' : FALLBACK_LANGUAGE
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
  if (instance) {
    return instance
  }
  const resolved = resolveLanguage(language)
  // Why: store the candidate in a local first, only assign to the module-level
  // singleton after init() resolves. If init() rejects, instance stays null and
  // getI18n() will throw a clear error rather than returning a broken object.
  const candidate = i18next.createInstance()
  await candidate.use(initReactI18next).init({
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
  instance = candidate
  return instance
}

export function getI18n(): I18nInstance {
  if (!instance) {
    throw new Error('i18n not initialized — call initI18n() first')
  }
  return instance
}
