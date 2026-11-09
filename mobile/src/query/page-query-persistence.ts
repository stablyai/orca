import type { QueryClient } from '@tanstack/react-query'
import type { PageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { firstPaintQueryKeys } from './first-paint-query-keys'
import { createHostQueryPersistence } from './host-query-persistence'

// How long a page holds its first render for stored data once everything else it waits on is ready.
const FIRST_PAINT_STORE_WAIT_MS = 150

/**
 * Keeps this document's query data in the phone's store and starts restoring its route's first screen.
 * Resolves when that restore is applied or missed; an older shell without the store resolves at once.
 */
export function startPageQueryPersistence(
  queryClient: QueryClient,
  store: PageDeviceStore,
  hostId: string,
  route: URL
): Promise<void> {
  if (!hostId || !store.available()) {
    return Promise.resolve()
  }
  const persistence = createHostQueryPersistence(queryClient, {
    hostId,
    read: (keys) => store.read('cache', keys),
    write: async (ops) => ({ written: (await store.write('cache', ops)).written })
  })
  // The shell finishes a write it was handed, so hiding is the last moment that needs one.
  const flush = (): void => void persistence.flush()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  })
  window.addEventListener('pagehide', flush)
  return persistence.restore(firstPaintQueryKeys(hostId, route))
}

/** Waits for the stored first screen, but never more than a short cap; a later answer still fills empty keys. */
export function awaitFirstPaintRestore(restore: Promise<void>): Promise<void> {
  return Promise.race([
    restore.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, FIRST_PAINT_STORE_WAIT_MS))
  ])
}
