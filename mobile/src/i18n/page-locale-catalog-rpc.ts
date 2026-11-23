import * as z from 'zod'
import type { SupportedUiLocale } from '../../../src/shared/i18n/ui-locale'
import {
  MOBILE_WEB_CATALOG_MAX_RAW_BYTES,
  MOBILE_WEB_CATALOG_MAX_RESULT_BYTES
} from '../../../src/shared/mobile-web-bundle/catalog-reply-size'
import {
  MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD,
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  MobileWebBundleGzipCatalogResultSchema,
  MobileWebBundleLocaleCatalogResultSchema
} from '../../../src/shared/mobile-web-bundle/locale-catalog-contract'
import { utf8ByteLength } from '../mobile-web-shell/bridge/protocol/bridge-caps'
import { captureRpcOperationSettlement, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { SendRequestOptions } from '../transport/rpc/unvalidated-rpc-request-port'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/client-state/bridge-rpc-client-contract'
import type { LocaleCatalog } from './bundled-locale-catalogs'

export type CatalogLocale = Exclude<SupportedUiLocale, 'en'>
export type HeldCatalog = { readonly sha256: string; readonly catalog: LocaleCatalog }
export type CatalogClient = Pick<
  BridgeRpcClient,
  'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'
>

const rawResult = MobileWebBundleLocaleCatalogResultSchema.loose()
const rawRead = defineRpcOperation({
  name: 'mobileWeb.bundle-locale-catalog',
  method: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('catalog', rawResult)
})
const encodedRead = defineRpcOperation({
  name: 'mobileWeb.bundle-locale-catalog-encoded',
  method: MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant(
    'catalog',
    z.union([MobileWebBundleGzipCatalogResultSchema, MobileWebBundleLocaleCatalogResultSchema])
  )
})

const REQUEST_WAIT_MS = 30_000
const OLD_HOST_DENIAL = `Method '${MOBILE_WEB_BUNDLE_ENCODED_CATALOG_METHOD}' is not available to mobile clients`

export async function requestHostLocaleCatalog(
  client: CatalogClient,
  locale: CatalogLocale,
  known: HeldCatalog | null,
  signal: AbortSignal,
  isCurrent: () => boolean
): Promise<HeldCatalog | null> {
  const params = { locale, ...(known && { knownSha256: known.sha256 }) }
  const deadline = performance.now() + REQUEST_WAIT_MS
  const options: SendRequestOptions = { timeoutMs: REQUEST_WAIT_MS, signal }
  const encoded = await captureRpcOperationSettlement(client, encodedRead, params, options)
  if (!isCurrent()) {
    throw new Error('catalog source retired')
  }
  const error =
    encoded.status === 'fulfilled' && encoded.outcome.kind === 'outer-refused'
      ? encoded.outcome.error
      : null
  const useRaw =
    error?.code === 'method_not_found' ||
    (error?.code === 'forbidden' && error.message === OLD_HOST_DENIAL)
  const remaining = Math.floor(deadline - performance.now())
  const reply =
    useRaw && remaining > 0
      ? await captureRpcOperationSettlement(client, rawRead, params, {
          ...options,
          timeoutMs: remaining
        })
      : encoded

  if (reply.status === 'rejected') {
    return null
  }
  if (!isCurrent() || reply.outcome.kind !== 'decoded' || reply.outcome.value.locale !== locale) {
    throw new Error(`[i18n] the desktop answered no ${locale} catalog`)
  }
  const { value } = reply.outcome
  if (!('catalog' in value)) {
    const [{ decodePageCatalogGzip }, { inflateCatalogGzip }] = await Promise.all([
      import('./page-locale-catalog-gzip'),
      import('./catalog-gzip-member')
    ])
    if (!isCurrent()) {
      throw new Error('catalog source retired')
    }
    return { sha256: value.sha256, catalog: decodePageCatalogGzip(value, inflateCatalogGzip) }
  }
  if (value.catalog === null && known?.sha256 === value.sha256) {
    return known
  }
  if (
    value.catalog === null ||
    (useRaw
      ? utf8ByteLength(JSON.stringify(value.catalog)) > MOBILE_WEB_CATALOG_MAX_RAW_BYTES
      : utf8ByteLength(JSON.stringify(value)) > MOBILE_WEB_CATALOG_MAX_RESULT_BYTES)
  ) {
    throw new Error('invalid identity catalog result')
  }
  return { sha256: value.sha256, catalog: value.catalog }
}
