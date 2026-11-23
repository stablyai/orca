import {
  DEVICE_STORE_MAX_VALUE_LENGTH,
  encodeDeviceStoreValue
} from '../device-store/device-store-value-codec'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/client-state/bridge-rpc-client-contract'
import type { PageDeviceStore } from '../mobile-web-shell/bridge/page-storage/page-device-store'
import {
  importBundledLocaleCatalog,
  type LocaleCatalog,
  type LocaleCatalogLoad
} from './bundled-locale-catalogs'
import { announceLocaleCatalog, publishPageLocaleCatalogLoader } from './locale-catalog-imports.web'
import {
  requestHostLocaleCatalog,
  type CatalogLocale,
  type CatalogClient,
  type HeldCatalog
} from './page-locale-catalog-rpc'
import { decodeStoredPageCatalog } from './stored-page-locale-catalog'

type CatalogSource = { readonly client: CatalogClient; readonly store: PageDeviceStore }

const FIRST_PAINT_CATALOG_WAIT_MS = 3_000
const storeKey = (locale: CatalogLocale): string => `i18n-catalog:${locale}`

async function readStoredCatalog(store: PageDeviceStore, locale: CatalogLocale) {
  if (!store.available()) {
    return null
  }
  const read = await store.read('cache', [storeKey(locale)]).catch(() => null)
  const raw = read?.status === 'ok' ? read.values[0] : null
  return raw ? decodeStoredPageCatalog(raw) : null
}

function persistCatalog(
  store: PageDeviceStore,
  locale: CatalogLocale,
  next: HeldCatalog,
  isCurrent: () => boolean
): void {
  setTimeout(() => {
    if (!isCurrent() || !store.available()) {
      return
    }
    const value = encodeDeviceStoreValue({ v: 1, sha256: next.sha256, catalog: next.catalog })
    if (value.length <= DEVICE_STORE_MAX_VALUE_LENGTH && isCurrent()) {
      void store
        .write('cache', [{ key: storeKey(locale), value }], isCurrent)
        .catch(() => undefined)
    }
  }, 0)
}

function whenConnected(
  client: CatalogClient,
  previousGeneration: number | undefined,
  signal: AbortSignal
): Promise<boolean> {
  let offline = previousGeneration === undefined || client.getState() !== 'connected'
  const ready = () =>
    client.getState() === 'connected' &&
    (offline || (client.getGeneration?.() ?? 0) !== previousGeneration)
  if (signal.aborted || client.getState() === 'auth-failed' || ready()) {
    return Promise.resolve(!signal.aborted && ready())
  }
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe()
      signal.removeEventListener('abort', done)
      resolve(!signal.aborted && ready())
    }
    const unsubscribe = client.onStateChange((state) => {
      offline ||= state !== 'connected'
      if (ready() || state === 'auth-failed') {
        done()
      }
    })
    signal.addEventListener('abort', done, { once: true })
  })
}

function firstPaint(locale: CatalogLocale, signal: AbortSignal, isCurrent: () => boolean) {
  let settle: ((value: LocaleCatalogLoad | PromiseLike<LocaleCatalogLoad>) => void) | undefined
  let reject: (reason: Error) => void
  const result = new Promise<LocaleCatalogLoad>((resolve, fail) => {
    settle = resolve
    reject = fail
  })
  const finish = (catalog?: LocaleCatalog): boolean => {
    const resolve = settle
    if (!resolve) {
      return false
    }
    settle = undefined
    clearTimeout(timer)
    signal.removeEventListener('abort', skip)
    if (catalog && isCurrent()) {
      resolve({ catalog, isCurrent })
      return true
    }
    reject(new Error(`[i18n] no ${locale} catalog for the first paint`))
    return false
  }
  const skip = () => {
    finish()
  }
  const timer = setTimeout(skip, FIRST_PAINT_CATALOG_WAIT_MS)
  signal.addEventListener('abort', skip, { once: true })
  return { result, finish, skip }
}

export function createHostLocaleCatalogLoader(
  { client, store }: CatalogSource,
  signal: AbortSignal,
  sourceIsCurrent: () => boolean
): (locale: CatalogLocale) => Promise<LocaleCatalogLoad> {
  type Flight = { pending: Promise<LocaleCatalogLoad> | null }
  const flights = new Map<CatalogLocale, Flight>()
  return (locale) => {
    if (signal.aborted || !sourceIsCurrent()) {
      return Promise.reject(new Error('catalog source retired'))
    }
    const held = flights.get(locale)?.pending
    if (held) {
      return held
    }
    const flight: Flight = { pending: null }
    flights.set(locale, flight)
    const isCurrent = () => !signal.aborted && sourceIsCurrent() && flights.get(locale) === flight
    const paint = firstPaint(locale, signal, isCurrent)
    flight.pending = paint.result
    void (async () => {
      const known = await readStoredCatalog(store, locale)
      if (!isCurrent()) {
        return
      }
      const publish = (catalog: LocaleCatalog) => {
        if (!paint.finish(catalog) && isCurrent()) {
          announceLocaleCatalog(locale, catalog)
        }
      }
      if (known) {
        publish(known.catalog)
      }
      const skipWhenOffline = (state: ReturnType<CatalogClient['getState']>) => {
        if (state !== 'connected') {
          paint.skip()
        }
      }
      skipWhenOffline(client.getState())
      const unsubscribe = client.onStateChange(skipWhenOffline)
      try {
        let previous: number | undefined
        while (isCurrent() && (await whenConnected(client, previous, signal))) {
          previous = client.getGeneration?.() ?? 0
          const next = await requestHostLocaleCatalog(client, locale, known, signal, isCurrent)
          if (next === null) {
            paint.skip()
            continue
          }
          if (next !== known && isCurrent()) {
            publish(next.catalog)
            persistCatalog(store, locale, next, isCurrent)
          }
          return
        }
      } finally {
        unsubscribe()
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        paint.skip()
        flight.pending = null
      })
    return paint.result
  }
}

export function startPageLocaleCatalogs({
  client,
  store
}: {
  client: BridgeRpcClient
  store: PageDeviceStore
}): () => void {
  const session = client.getShellSession()
  const controller = new AbortController()
  const checkRevocation = () => {
    if (
      (client.getState() === 'auth-failed' && client.getActivePath() !== 'relay') ||
      client.getRelayHostReachability() === 'credential-refused'
    ) {
      controller.abort()
    }
  }
  const stopState = client.onStateChange(checkRevocation)
  const stopPath = client.onConnectionPathChange(checkRevocation)
  checkRevocation()
  const isCurrent = () => {
    const active = client.getShellSession()
    return (
      session !== null &&
      active?.sessionId === session.sessionId &&
      active.host?.id === session.host?.id
    )
  }
  const hostCatalog = createHostLocaleCatalogLoader({ client, store }, controller.signal, isCurrent)
  publishPageLocaleCatalogLoader(async (locale) => {
    const chunk = await importBundledLocaleCatalog(locale).catch(() => null)
    return chunk ? { catalog: chunk } : hostCatalog(locale)
  })
  return () => {
    stopState()
    stopPath()
    controller.abort()
  }
}
