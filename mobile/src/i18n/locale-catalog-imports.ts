import type { SupportedUiLocale } from '../../../src/shared/ui-locale'

export type LocaleCatalog = Readonly<Record<string, unknown>>

// Literal specifiers: Metro evaluates only the chosen module, and the page build splits each into its own chunk.
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

export function importLocaleCatalog(
  locale: Exclude<SupportedUiLocale, 'en'>
): Promise<LocaleCatalog> {
  return CATALOG_IMPORTS[locale]()
}
