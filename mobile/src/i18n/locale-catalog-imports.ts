import type { SupportedUiLocale } from '../../../src/shared/ui-locale'
import type { LocaleCatalog } from './bundled-locale-catalogs'

export { importBundledLocaleCatalog as importLocaleCatalog } from './bundled-locale-catalogs'

// Bundled catalogs never change after their import, so none arrives later; the page build's .web.ts does.
export const onLocaleCatalogArrival: (
  listener: (locale: Exclude<SupportedUiLocale, 'en'>, catalog: LocaleCatalog) => void
) => () => void = () => () => undefined
