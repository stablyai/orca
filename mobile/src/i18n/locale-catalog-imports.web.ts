import type { SupportedUiLocale } from '../../../src/shared/i18n/ui-locale'
import {
  importBundledLocaleCatalog,
  type LocaleCatalog,
  type LocaleCatalogLoad
} from './bundled-locale-catalogs'

// A shell that skips the catalog chunks has page-locale-catalog-source.ts read them from the desktop
// and the device store; other shells import the chunk as before. No transport here, so pages that
// only translate pull in none.
export type { LocaleCatalog }
type CatalogLocale = Exclude<SupportedUiLocale, 'en'>
type CatalogLoader = (locale: CatalogLocale) => Promise<LocaleCatalogLoad>
type ArrivalListener = (locale: CatalogLocale, catalog: LocaleCatalog) => void

let loader: CatalogLoader | null = null
const arrivalListeners = new Set<ArrivalListener>()

export function publishPageLocaleCatalogLoader(next: CatalogLoader): void {
  loader = next
}

// Resolve the catalog or reject so activation falls back to English.
export async function importLocaleCatalog(locale: CatalogLocale): Promise<LocaleCatalogLoad> {
  return loader === null ? { catalog: await importBundledLocaleCatalog(locale) } : loader(locale)
}

// A catalog that arrives after activation settled: a newer copy, or the first one after an offline start.
export function onLocaleCatalogArrival(listener: ArrivalListener): () => void {
  arrivalListeners.add(listener)
  return () => {
    arrivalListeners.delete(listener)
  }
}

export function announceLocaleCatalog(locale: CatalogLocale, catalog: LocaleCatalog): void {
  for (const listener of arrivalListeners) {
    listener(locale, catalog)
  }
}
