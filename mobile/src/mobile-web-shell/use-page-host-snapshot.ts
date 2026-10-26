import { useCallback, useEffect, useState } from 'react'
import { loadHosts } from '../transport/host-store'
import type { BridgeInitHost } from './bridge/bridge-envelope'
import {
  hydrateMirroredStorage,
  readMirroredKeyOrStore,
  readMirroredStorage,
  writeMirroredStorage
} from '../storage/mirrored-storage-keys'
import {
  isHostWorkspaceStorageKey,
  isPageStorageKeyForRoute,
  pageStorageEntriesForInit,
  pageStorageKeysForRoute,
  type PageStorageForInit
} from './page-storage-keys'

export type PageHostSnapshot = {
  host: BridgeInitHost
}

export type PageHostSnapshotView = {
  snapshot: PageHostSnapshot | null
  // Report rejected profile reads; no host can answer ready and nothing retries this read automatically.
  unreadable: boolean
  // Keep init synchronous from a mirror updated by native writers and refreshed from the store.
  readStorage: () => PageStorageForInit
  refreshStorage: () => Promise<void>
  writeStorage: (key: string, value: string | null) => void
  readWorkspaceKey: (key: string) => Promise<string | null>
}

// Read native profile/storage into init because web SecureStore is empty and localStorage is disabled/session-scoped. Refresh keys for every init; profile identity stays fixed for the mount.
export function usePageHostSnapshot(
  hostId: string,
  routePathname: string,
  hostArea = false
): PageHostSnapshotView {
  const [snapshot, setSnapshot] = useState<PageHostSnapshot | null>(null)
  const [unreadable, setUnreadable] = useState(false)

  // Apply the shell allowlist on every read/refresh; unrelated mirrored app state must never cross.
  const refreshStorage = useCallback(
    (): Promise<void> => hydrateMirroredStorage(pageStorageKeysForRoute(hostId, routePathname)),
    [hostId, routePathname]
  )

  useEffect(() => {
    let stale = false
    setSnapshot(null)
    setUnreadable(false)
    // Wait for profile and storage together; a fast profile would otherwise build a host that primes empty preferences.
    void Promise.all([refreshStorage(), loadHosts()]).then(
      ([, hosts]) => {
        if (stale) {
          return
        }
        const found = hosts.find((profile) => profile.id === hostId)
        setSnapshot(
          found
            ? {
                host: {
                  id: found.id,
                  name: found.name,
                  ...(found.personalName !== undefined ? { personalName: found.personalName } : {}),
                  ...(found.lastKnownMachineName !== undefined
                    ? { lastKnownMachineName: found.lastKnownMachineName }
                    : {}),
                  ...(found.lastKnownHostPlatform !== undefined
                    ? { lastKnownHostPlatform: found.lastKnownHostPlatform }
                    : {}),
                  endpoint: found.endpoint,
                  lastConnected: found.lastConnected
                }
              }
            : null
        )
      },
      () => {
        // Failed keychain reads neither prove host removal nor retry themselves; report failure instead of leaving ready unanswered.
        if (!stale) {
          setUnreadable(true)
        }
      }
    )
    return () => {
      stale = true
    }
  }, [hostId, refreshStorage])

  const writeStorage = useCallback(
    (key: string, value: string | null): void => {
      // Recheck the allowlist so the mirror cannot temporarily expose values its next refresh drops.
      if (!isPageStorageKeyForRoute(key, hostId, routePathname, hostArea)) {
        return
      }
      writeMirroredStorage(key, value)
    },
    [hostArea, hostId, routePathname]
  )

  const readWorkspaceKey = useCallback(
    async (key: string): Promise<string | null> => {
      if (!hostArea || !isHostWorkspaceStorageKey(key, hostId)) {
        throw new Error('this page may not read that key')
      }
      // Update the map before async persistence so init sees shell-side writes immediately.
      return readMirroredKeyOrStore(key)
    },
    [hostArea, hostId]
  )

  return {
    snapshot,
    unreadable,
    readStorage: useCallback(() => {
      // Bound values here or one oversized preference rejects all of init; report omissions so defaulted preferences are diagnosable.
      const held = readMirroredStorage(pageStorageKeysForRoute(hostId, routePathname))
      const { entries, dropped, oversize } = pageStorageEntriesForInit(held)
      if (dropped.length > 0) {
        console.warn('[web-shell] a stored value is too large for the page', { keys: dropped })
      }
      // Tell the page which oversized values are missing so it cannot replace unseen contents (ruling 33.6).
      return { storage: entries, storageOversize: oversize }
    }, [hostId, routePathname]),
    refreshStorage,
    writeStorage,
    readWorkspaceKey
  }
}
