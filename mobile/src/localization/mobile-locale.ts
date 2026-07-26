import { english, type TranslationCatalog, type TranslationKey } from './catalogs/en'
import { simplifiedChinese } from './catalogs/zh-CN'

export const mobileLocales = ['en', 'zh-CN'] as const

export type MobileLocale = (typeof mobileLocales)[number]
export type TranslationValues = Record<string, string | number>
export type MobileTranslator = (key: TranslationKey, values?: TranslationValues) => string

const dictionaries = {
  en: english,
  'zh-CN': simplifiedChinese
} satisfies Record<MobileLocale, TranslationCatalog>

export function parseMobileLocale(value: unknown): MobileLocale | null {
  if (typeof value !== 'string') {
    return null
  }
  return mobileLocales.find((locale) => locale === value) ?? null
}

export function translateMobileCopy(
  locale: MobileLocale,
  key: TranslationKey,
  values: TranslationValues = {}
): string {
  return Object.entries(values).reduce(
    (copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)),
    dictionaries[locale][key]
  )
}

export type { TranslationKey }
