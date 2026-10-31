import type { SupportedUiLocale } from '../../../src/shared/ui-locale'
import { getMobileUiLocale } from './mobile-i18n'

// Explicit script/region: Hermes passes tags to the platform formatter, which reads bare `zh` and `pt` differently by OS.
const INTL_LOCALE: Record<SupportedUiLocale, string> = {
  en: 'en',
  de: 'de',
  es: 'es',
  fr: 'fr',
  ja: 'ja',
  ko: 'ko',
  pt: 'pt-BR',
  ru: 'ru',
  tr: 'tr',
  zh: 'zh-Hans',
  'zh-Hant': 'zh-Hant'
}

export function intlLocaleFor(locale: SupportedUiLocale): string {
  return INTL_LOCALE[locale]
}

// Format dates and numbers in the UI language, not the platform default (`undefined`).
export function getUiIntlLocale(): string {
  return INTL_LOCALE[getMobileUiLocale()]
}
