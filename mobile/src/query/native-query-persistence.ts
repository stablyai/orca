import { AppState, Platform } from 'react-native'
import type { QueryClient } from '@tanstack/react-query'
import { processDeviceStore } from '../device-store/device-store'
import {
  createHostQueryPersistence,
  hostQueryPersistenceOf,
  type HostQueryPersistence
} from './host-query-persistence'
import { hostScopeKey } from './host-query-key'

// Per native world, the paired hosts whose data it keeps in the device store.
const keptHosts = new WeakMap<QueryClient, Set<string>>()

function keptHostsOf(queryClient: QueryClient): Set<string> {
  const existing = keptHosts.get(queryClient)
  if (existing) {
    return existing
  }
  const hosts = new Set<string>()
  keptHosts.set(queryClient, hosts)
  // Pending writes go to disk when the app leaves the foreground, as a page's do on hide.
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      for (const hostId of hosts) {
        void hostQueryPersistenceOf(queryClient, hostId)?.flush()
      }
    }
  })
  return hosts
}

/** Keeps the native world's data for one paired host in the device store, read and written directly. */
export function keepNativeHostQueries(
  queryClient: QueryClient,
  hostId: string
): HostQueryPersistence | null {
  // The web build of the native app has no device store.
  if (Platform.OS === 'web') {
    return null
  }
  const existing = hostQueryPersistenceOf(queryClient, hostId)
  if (existing) {
    return existing
  }
  const hosts = keptHostsOf(queryClient)
  hosts.add(hostId)
  const store = processDeviceStore()
  return createHostQueryPersistence(queryClient, {
    hostId,
    read: (keys) => store.read(hostId, 'cache', keys),
    // A write still pending when the host is removed must not land after the wipe.
    write: async (ops) =>
      hosts.has(hostId)
        ? { written: (await store.write(hostId, 'cache', ops)).written }
        : { written: false }
  })
}

/** Whether this world's writes can reach disk now: false on web, or while the store's key can't load. */
export async function nativeQueryStoreReady(): Promise<boolean> {
  return Platform.OS !== 'web' && (await processDeviceStore().open()) === 'ready'
}

/** Drops a removed host's queries from this world and stops storing them; the store wipe follows. */
export function forgetNativeHostQueries(queryClient: QueryClient, hostId: string): void {
  keptHosts.get(queryClient)?.delete(hostId)
  hostQueryPersistenceOf(queryClient, hostId)?.stop()
  queryClient.removeQueries({ queryKey: hostScopeKey(hostId) })
}
