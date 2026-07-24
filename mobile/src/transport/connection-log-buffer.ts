import type { ConnectionLogEntry } from './types'

// Why: the rpc-client's onLog entries were only wired during pairing; for
// long-lived host connections everything went to console.log, invisible to
// users. This buffer retains the recent lifecycle events per host so a
// "Connection log" screen (and copy-diagnostics) can show why a connection
// is stuck without a debug build. Module-level so the log survives client
// swaps (forceReconnect) and provider remounts (hot reload); bounded so an
// all-night reconnect loop can't grow memory unbounded.
const MAX_ENTRIES_PER_HOST = 200

export type ConnectionLogStore = {
  append: (hostId: string, entry: ConnectionLogEntry) => void
  get: (hostId: string) => readonly ConnectionLogEntry[]
  subscribe: (hostId: string, listener: () => void) => () => void
}

export function createConnectionLogStore(
  maxEntriesPerHost: number = MAX_ENTRIES_PER_HOST
): ConnectionLogStore {
  const entriesByHost = new Map<string, ConnectionLogEntry[]>()
  const listenersByHost = new Map<string, Set<() => void>>()
  // Why: useSyncExternalStore compares snapshots by reference — getSnapshot
  // must return the SAME array until the data actually changes, or React
  // loops re-rendering. Cache per host; invalidate on append.
  const snapshotByHost = new Map<string, readonly ConnectionLogEntry[]>()
  const EMPTY: readonly ConnectionLogEntry[] = []

  return {
    append(hostId, entry) {
      let entries = entriesByHost.get(hostId)
      if (!entries) {
        entries = []
        entriesByHost.set(hostId, entries)
      }
      entries.push(entry)
      if (entries.length > maxEntriesPerHost) {
        entries.splice(0, entries.length - maxEntriesPerHost)
      }
      snapshotByHost.delete(hostId)
      const listeners = listenersByHost.get(hostId)
      if (listeners) {
        for (const listener of listeners) {
          listener()
        }
      }
    },

    get(hostId) {
      const cached = snapshotByHost.get(hostId)
      if (cached) {
        return cached
      }
      const entries = entriesByHost.get(hostId)
      if (!entries || entries.length === 0) {
        return EMPTY
      }
      const snapshot = Object.freeze([...entries])
      snapshotByHost.set(hostId, snapshot)
      return snapshot
    },

    subscribe(hostId, listener) {
      let listeners = listenersByHost.get(hostId)
      if (!listeners) {
        listeners = new Set()
        listenersByHost.set(hostId, listeners)
      }
      listeners.add(listener)
      return () => {
        const set = listenersByHost.get(hostId)
        if (!set) {
          return
        }
        set.delete(listener)
        if (set.size === 0) {
          listenersByHost.delete(hostId)
        }
      }
    }
  }
}

export const connectionLogStore = createConnectionLogStore()
