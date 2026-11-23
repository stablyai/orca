import type { SupportedUiLocale } from '../../../src/shared/i18n/ui-locale'
import {
  importBundledLocaleCatalog,
  type LocaleCatalog,
  type LocaleCatalogLoad
} from './bundled-locale-catalogs'

export async function importLocaleCatalog(
  locale: Exclude<SupportedUiLocale, 'en'>
): Promise<LocaleCatalogLoad> {
  return { catalog: await importBundledLocaleCatalog(locale) }
}

// Bundled catalogs never change after their import, so none arrives later; the page build's .web.ts does.
export const onLocaleCatalogArrival: (
  listener: (locale: Exclude<SupportedUiLocale, 'en'>, catalog: LocaleCatalog) => void
) => () => void = () => () => undefined
