import { gunzipSync, strFromU8 } from 'fflate'
import type { SupportedUiLocale } from '../../../src/shared/i18n/ui-locale'
import { decodeBase64Bytes } from '../transport/encryption/base64-byte-codec'

export type LocaleCatalog = Readonly<Record<string, unknown>>

// Literal specifiers: Metro evaluates only the chosen module, and the page build splits each into its own chunk.
const CATALOG_IMPORTS: Record<Exclude<SupportedUiLocale, 'en'>, () => Promise<string>> = {
  de: () => import('./locales-compressed/de.generated').then((module) => module.default),
  es: () => import('./locales-compressed/es.generated').then((module) => module.default),
  fr: () => import('./locales-compressed/fr.generated').then((module) => module.default),
  ja: () => import('./locales-compressed/ja.generated').then((module) => module.default),
  ko: () => import('./locales-compressed/ko.generated').then((module) => module.default),
  pt: () => import('./locales-compressed/pt.generated').then((module) => module.default),
  ru: () => import('./locales-compressed/ru.generated').then((module) => module.default),
  tr: () => import('./locales-compressed/tr.generated').then((module) => module.default),
  zh: () => import('./locales-compressed/zh.generated').then((module) => module.default),
  'zh-Hant': () => import('./locales-compressed/zh-Hant.generated').then((module) => module.default)
}

function isLocaleCatalog(value: unknown): value is LocaleCatalog {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function importBundledLocaleCatalog(
  locale: Exclude<SupportedUiLocale, 'en'>
): Promise<LocaleCatalog> {
  const encoded = await CATALOG_IMPORTS[locale]()
  const parsed: unknown = JSON.parse(strFromU8(gunzipSync(decodeBase64Bytes(encoded))))
  if (!isLocaleCatalog(parsed)) {
    throw new Error(`Invalid bundled locale catalog for ${locale}`)
  }
  return parsed
}
