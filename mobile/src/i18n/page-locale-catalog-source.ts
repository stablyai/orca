import * as z from 'zod'
import type { SupportedUiLocale } from '../../../src/shared/ui-locale'
import { SHA256_PATTERN } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  MobileWebBundleLocaleCatalogResultSchema
} from '../../../src/shared/mobile-web-bundle/locale-catalog-contract'
import { withTimeoutResult } from '../../../src/shared/promise-timeout-fallback'
import {
  decodeDeviceStoreValue,
  encodeDeviceStoreValue
} from '../device-store/device-store-value-codec'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import type { PageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { isMobileMethodUnavailableError } from '../transport/rpc/mobile-method-unavailable'
import { captureRpcOperationSettlement, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { importBundledLocaleCatalog } from './bundled-locale-catalogs'
import {
  announceLocaleCatalog as announce,
  publishPageLocaleCatalogLoader,
  type LocaleCatalog
} from './locale-catalog-imports.web'

// The desktop serves the active catalog and the phone keeps a copy per host; only the page entry imports this.
type CatalogLocale = Exclude<SupportedUiLocale, 'en'>
type HeldCatalog = { readonly sha256: string; readonly catalog: LocaleCatalog }
type CatalogClient = Pick<
  BridgeRpcClient,
  'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'
>
type CatalogSource = { readonly client: CatalogClient; readonly store: PageDeviceStore }

const storedCatalogSchema = z.object({
  v: z.literal(1),
  sha256: z.string().regex(SHA256_PATTERN),
  catalog: z.record(z.string(), z.unknown())
})

const localeCatalogRead = defineRpcOperation({
  name: 'mobileWeb.bundle-locale-catalog',
  method: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  // Loose like every phone reader, so a host may add fields.
  read: rpcResultVariant(
    'mobile-web-bundle-locale-catalog',
    MobileWebBundleLocaleCatalogResultSchema.loose()
  )
})

const syncing = new Set<CatalogLocale>()
// The stored read plus a relay round trip with the largest catalog fit well inside; past it the page opens in English.
const FIRST_PAINT_CATALOG_WAIT_MS = 3_000

const storeKey = (locale: CatalogLocale): string => `i18n-catalog:${locale}`

async function readStoredCatalog(
  store: PageDeviceStore,
  locale: CatalogLocale
): Promise<HeldCatalog | null> {
  if (!store.available()) {
    return null
  }
  const read = await store.read('cache', [storeKey(locale)]).catch(() => null)
  const raw = read?.status === 'ok' ? read.values[0] : null
  if (!raw) {
    return null
  }
  const parsed = storedCatalogSchema.safeParse(decodeDeviceStoreValue(raw))
  return parsed.success ? { sha256: parsed.data.sha256, catalog: parsed.data.catalog } : null
}

function writeStoredCatalog(
  store: PageDeviceStore,
  locale: CatalogLocale,
  next: HeldCatalog
): void {
  if (store.available()) {
    const value = encodeDeviceStoreValue({ v: 1, ...next })
    void store.write('cache', [{ key: storeKey(locale), value }]).catch(() => undefined)
  }
}

// A send the host never answered, as opposed to a refusal or an unreadable reply.
class CatalogSendFailed extends Error {
  constructor(
    message: string,
    readonly generation: number | null = null
  ) {
    super(message)
  }
}

const generationOf = (client: CatalogClient): number | null => client.getGeneration?.() ?? null

// After a failed send, wait for a reconnect or a cutover to another connection, which is often connected already.
// False once pairing is revoked: that connection never comes back.
function whenConnected(client: CatalogClient, failedGeneration: number | null): Promise<boolean> {
  let reconnected = failedGeneration === null || client.getState() !== 'connected'
  const ready = (): boolean =>
    client.getState() === 'connected' && (reconnected || generationOf(client) !== failedGeneration)
  if (ready() || client.getState() === 'auth-failed') {
    return Promise.resolve(ready())
  }
  return new Promise((resolve) => {
    const stop = client.onStateChange((state) => {
      reconnected ||= state !== 'connected'
      if (ready() || state === 'auth-failed') {
        stop()
        resolve(ready())
      }
    })
  })
}

// Rejects when the connection drops first, so a first paint never waits on a reply that can't come.
function beforeConnectionLoss<T>(client: CatalogClient, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = client.onStateChange((state) => {
      if (state !== 'connected') {
        stop()
        reject(new CatalogSendFailed('[i18n] connection lost before the catalog arrived'))
      }
    })
    work.then(
      (value) => {
        stop()
        resolve(value)
      },
      (error: unknown) => {
        stop()
        reject(error)
      }
    )
  })
}

// One request. On an answer the copy becomes the page's and the store's.
async function askHost(
  { client, store }: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined
): Promise<HeldCatalog> {
  const generation = generationOf(client)
  const settled = await captureRpcOperationSettlement(client, localeCatalogRead, {
    locale,
    ...(known ? { knownSha256: known.sha256 } : {})
  })
  if (settled.status === 'rejected') {
    throw new CatalogSendFailed(`[i18n] the ${locale} catalog request got no answer`, generation)
  }
  const { outcome } = settled
  if (outcome.kind === 'decoded') {
    const { sha256, catalog } = outcome.value
    // A null catalog only confirms the copy the phone named.
    const next = catalog !== null ? { sha256, catalog } : known?.sha256 === sha256 ? known : null
    if (next) {
      if (next !== known) {
        // After the first paint: encoding the copy is main-thread work nothing waits on.
        setTimeout(() => {
          writeStoredCatalog(store, locale, next)
        }, 0)
      }
      return next
    }
  }
  const refusal = outcome.kind === 'outer-refused' ? outcome.error : undefined
  throw new Error(
    isMobileMethodUnavailableError(refusal?.code, refusal?.message)
      ? '[i18n] this desktop serves no language catalogs'
      : `[i18n] the desktop answered no ${locale} catalog`
  )
}

// Asks until the host answers, resending once per new connection; a refusal ends it.
async function syncFromHost(
  current: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined,
  failedGeneration: number | null
): Promise<HeldCatalog> {
  for (;;) {
    if (!(await whenConnected(current.client, failedGeneration))) {
      throw new Error('[i18n] this phone is no longer paired with the desktop')
    }
    try {
      return await askHost(current, locale, known)
    } catch (error) {
      if (!(error instanceof CatalogSendFailed)) {
        throw error
      }
      failedGeneration = error.generation
    }
  }
}

// One sync per locale, announcing a copy other than the one the page already shows.
function syncOnce(
  current: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined,
  failedGeneration: number | null = null
): void {
  if (syncing.has(locale)) {
    return
  }
  syncing.add(locale)
  syncFromHost(current, locale, known, failedGeneration).then(
    (next) => {
      syncing.delete(locale)
      if (next !== known) {
        announce(locale, next.catalog)
      }
    },
    () => {
      syncing.delete(locale)
    }
  )
}

// What a first paint may wait for: the stored copy, else one request while connected.
async function firstCatalog(current: CatalogSource, locale: CatalogLocale): Promise<HeldCatalog> {
  // Only a locale with no catalog installed is asked for, so nothing is held in memory here.
  const known = await readStoredCatalog(current.store, locale)
  if (known) {
    // Show the stored copy now; a newer one replaces it when the host answers.
    syncOnce(current, locale, known)
    return known
  }
  if (current.client.getState() !== 'connected') {
    throw new CatalogSendFailed('[i18n] no connection for the catalog yet')
  }
  return beforeConnectionLoss(current.client, askHost(current, locale, undefined))
}

async function loadCatalog(current: CatalogSource, locale: CatalogLocale): Promise<LocaleCatalog> {
  // A generation an older shell downloaded still holds the chunk: no wait, and this page's own strings.
  const bundled = await importBundledLocaleCatalog(locale).catch(() => null)
  if (bundled !== null) {
    return bundled
  }
  const first = firstCatalog(current, locale)
  const settled = await withTimeoutResult(first, FIRST_PAINT_CATALOG_WAIT_MS)
  if (settled.ok) {
    return settled.value.catalog
  }
  // Activation shows English meanwhile; whatever comes later switches the page in place.
  first.then(
    (late) => {
      announce(locale, late.catalog)
    },
    (failure: unknown) => {
      if (failure instanceof CatalogSendFailed) {
        syncOnce(current, locale, undefined, failure.generation)
      }
    }
  )
  throw new Error(`[i18n] no ${locale} catalog for the first paint`)
}

// Before the first activation, so its catalog comes from the desktop and the store.
export function startPageLocaleCatalogs(current: CatalogSource): void {
  publishPageLocaleCatalogLoader((locale) => loadCatalog(current, locale))
}
