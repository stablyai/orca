import { useCallback, useEffect, useState } from 'react'
import { loadHosts } from '../transport/host-store'
import type { BridgeInitHost } from './bridge/bridge-envelope'
import {
  hydrateMirroredStorage,
  readMirroredStorage,
  writeMirroredStorage
} from '../storage/mirrored-storage-keys'
import {
  isPageStorageKeyForRoute,
  pageStorageEntriesForInit,
  pageStorageKeysForRoute,
  type PageStorageForInit
} from './page-storage-keys'

export type PageHostSnapshot = {
  host: BridgeInitHost
}

export type PageHostSnapshotView = {
  /** Null while the profile read is in flight, and for a host that is not in the store. */
  snapshot: PageHostSnapshot | null
  /**
   * The profile read rejected. No host is ever built from it, so without this the session sits in
   * `ready` with the view un-hidden, no host behind it, and the page re-posting `ready` forever.
   */
  unreadable: boolean
  /**
   * The allowlisted keys as the app currently holds them, for the host to put on every `init`.
   * Synchronous because `init` is; the app's own writers keep it current as they write.
   */
  readStorage: () => PageStorageForInit
  /** Re-seats that map on the app's store. Cheap, and asked for whenever a page asks to start. */
  refreshStorage: () => Promise<void>
  /** Applies one page write to the app's store and to the map the next `init` will carry. */
  writeStorage: (key: string, value: string | null) => void
}

/**
 * What the page cannot read for itself: this host, and the few stored keys its screens keep.
 *
 * `expo-secure-store` is `{}` on web and AsyncStorage's web build is `window.localStorage`, which
 * the page has none of — Android turns DOM storage off and on iOS the origin is the session id, so
 * a page-side write is gone on the next remount. Both cross in `init` instead.
 *
 * The profile is read once per mount, because a host's identity does not change under one. The
 * keys are re-seated per `init` answer, because the store is their truth; between those reads the
 * map is kept current by every writer of one, which is what lets `init` stay synchronous.
 */
export function usePageHostSnapshot(hostId: string, routePathname: string): PageHostSnapshotView {
  const [snapshot, setSnapshot] = useState<PageHostSnapshot | null>(null)
  const [unreadable, setUnreadable] = useState(false)

  // The allowlist is the shell's, not the mirror's: what the page may be handed is named here on
  // every read and every seat, so nothing else the app happens to mirror can reach it.
  const refreshStorage = useCallback(
    (): Promise<void> => hydrateMirroredStorage(pageStorageKeysForRoute(hostId, routePathname)),
    [hostId, routePathname]
  )

  useEffect(() => {
    let stale = false
    setSnapshot(null)
    setUnreadable(false)
    // Both reads, not whichever answers first. The host is built from the snapshot and answers the
    // page's pending `ready` the moment it exists, so a profile that beat the store would put the
    // page's own keys behind an empty map: the list paints unpinned and the New Workspace drawer
    // opens on no repo until something else reconciles it. Only the profile read can reject.
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
        // A keychain read that failed is not a host that is gone, and it is not something to wait
        // out either: nothing retries it, so the caller is told rather than left holding a `ready`
        // session with no host behind it.
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
      // The host refuses a key outside this list before this ever runs. Held to it here too, so the
      // map cannot hold something the next refresh would drop and answer a read with it meanwhile.
      if (!isPageStorageKeyForRoute(key, hostId, routePathname)) {
        return
      }
      writeMirroredStorage(key, value)
    },
    [hostId, routePathname]
  )

  return {
    snapshot,
    unreadable,
    readStorage: useCallback(() => {
      // Bounded here rather than at the mirror, which holds no policy about the keys it is asked
      // for: a value over the cap would otherwise reach `init`, where the page's own schema
      // refuses the whole frame and the screen never opens. The name of what was left out is
      // reported rather than swallowed, because a preference falling back to its default is a
      // degradation someone has to be able to read.
      const held = readMirroredStorage(pageStorageKeysForRoute(hostId, routePathname))
      const { entries, dropped, oversize } = pageStorageEntriesForInit(held)
      if (dropped.length > 0) {
        console.warn('[web-shell] a stored value is too large for the page', { keys: dropped })
      }
      // `oversize` crosses as well as being logged: a key the page holds no value for is one its
      // own write would replace rather than extend (ruling 33.6).
      return { storage: entries, storageOversize: oversize }
    }, [hostId, routePathname]),
    refreshStorage,
    writeStorage
  }
}
