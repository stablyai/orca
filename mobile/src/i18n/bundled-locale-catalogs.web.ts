import type { SupportedUiLocale } from '../../../src/shared/i18n/ui-locale'
import type { LocaleCatalog } from './bundled-locale-catalogs'

export type { LocaleCatalog }

// Literal specifiers: the page build splits each raw JSON catalog into its own locale-catalog chunk.
const CATALOG_IMPORTS: Record<Exclude<SupportedUiLocale, 'en'>, () => Promise<LocaleCatalog>> = {
  de: () => import('./locales/de.json').then((module) => module.default),
  es: () => import('./locales/es.json').then((module) => module.default),
  fr: () => import('./locales/fr.json').then((module) => module.default),
  ja: () => import('./locales/ja.json').then((module) => module.default),
  ko: () => import('./locales/ko.json').then((module) => module.default),
  pt: () => import('./locales/pt.json').then((module) => module.default),
  ru: () => import('./locales/ru.json').then((module) => module.default),
  tr: () => import('./locales/tr.json').then((module) => module.default),
  zh: () => import('./locales/zh.json').then((module) => module.default),
  'zh-Hant': () => import('./locales/zh-Hant.json').then((module) => module.default)
}

export function importBundledLocaleCatalog(
  locale: Exclude<SupportedUiLocale, 'en'>
): Promise<LocaleCatalog> {
  return CATALOG_IMPORTS[locale]()
}
