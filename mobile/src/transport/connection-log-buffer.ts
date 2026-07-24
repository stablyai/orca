import type { ConnectionLogEntry } from './types'
import { measureUtf8ByteLength } from '../../../src/shared/utf8-byte-limits'

// Why: the rpc-client's onLog entries were only wired during pairing; for
// long-lived host connections everything went to console.log, invisible to
// users. This buffer retains the recent lifecycle events per host so a
// "Connection log" screen (and copy-diagnostics) can show why a connection
// is stuck without a debug build. Module-level so the log survives client
// swaps (forceReconnect) and provider remounts (hot reload); bounded so an
// all-night reconnect loop can't grow memory unbounded.
const MAX_ENTRIES_PER_HOST = 200
const MAX_RETAINED_HOSTS = 128
export const CONNECTION_LOG_HOST_ID_MAX_BYTES = 4 * 1024
export const CONNECTION_LOG_ENTRY_MAX_BYTES = 64 * 1024
export const CONNECTION_LOG_HOST_MAX_RETAINED_BYTES = 256 * 1024
export const CONNECTION_LOG_STORE_MAX_RETAINED_BYTES = 8 * 1024 * 1024
const CONNECTION_LOG_MAX_LISTENERS_PER_HOST = 16

type RetainedConnectionLogEntry = {
  entry: ConnectionLogEntry
  bytes: number
}

type RetainedHostLog = {
  entries: RetainedConnectionLogEntry[]
  bytes: number
}

type ConnectionLogByteLimits = {
  maxEntryBytes: number
  maxHostBytes: number
  maxStoreBytes: number
}

function measureBoundedString(value: unknown, maxBytes: number): number | null {
  if (value === undefined) {
    return 0
  }
  if (typeof value !== 'string') {
    return null
  }
  const measurement = measureUtf8ByteLength(value, { stopAfterBytes: maxBytes })
  return measurement.exceededLimit ? null : measurement.byteLength
}

function measureConnectionLogEntry(entry: ConnectionLogEntry, maxBytes: number): number | null {
  let bytes = 256
  for (const value of [entry.id, entry.level, entry.message, entry.detail]) {
    const valueBytes = measureBoundedString(value, maxBytes - bytes)
    if (valueBytes === null) {
      return null
    }
    bytes += valueBytes
  }
  return bytes <= maxBytes ? bytes : null
}

export type ConnectionLogStore = {
  append: (hostId: string, entry: ConnectionLogEntry) => void
  get: (hostId: string) => readonly ConnectionLogEntry[]
  subscribe: (hostId: string, listener: () => void) => () => void
  delete: (hostId: string) => void
}

export function createConnectionLogStore(
  maxEntriesPerHost: number = MAX_ENTRIES_PER_HOST,
  maxRetainedHosts: number = MAX_RETAINED_HOSTS,
  byteLimits: Partial<ConnectionLogByteLimits> = {}
): ConnectionLogStore {
  const maxEntryBytes = Math.min(
    byteLimits.maxEntryBytes ?? CONNECTION_LOG_ENTRY_MAX_BYTES,
    CONNECTION_LOG_ENTRY_MAX_BYTES
  )
  const maxHostBytes = Math.min(
    byteLimits.maxHostBytes ?? CONNECTION_LOG_HOST_MAX_RETAINED_BYTES,
    CONNECTION_LOG_HOST_MAX_RETAINED_BYTES
  )
  const maxStoreBytes = Math.min(
    byteLimits.maxStoreBytes ?? CONNECTION_LOG_STORE_MAX_RETAINED_BYTES,
    CONNECTION_LOG_STORE_MAX_RETAINED_BYTES
  )
  const entriesByHost = new Map<string, RetainedHostLog>()
  const listenersByHost = new Map<string, Set<() => void>>()
  // Why: useSyncExternalStore compares snapshots by reference — getSnapshot
  // must return the SAME array until the data actually changes, or React
  // loops re-rendering. Cache per host; invalidate on append.
  const snapshotByHost = new Map<string, readonly ConnectionLogEntry[]>()
  const EMPTY: readonly ConnectionLogEntry[] = []
  let retainedStoreBytes = 0

  const deleteHost = (hostId: string): boolean => {
    const host = entriesByHost.get(hostId)
    if (!host) {
      return false
    }
    entriesByHost.delete(hostId)
    retainedStoreBytes -= host.bytes
    snapshotByHost.delete(hostId)
    return true
  }

  const evictOldestUnobservedHost = (exceptHostId?: string): boolean => {
    for (const hostId of entriesByHost.keys()) {
      if (hostId !== exceptHostId && !listenersByHost.has(hostId)) {
        return deleteHost(hostId)
      }
    }
    return false
  }

  return {
    append(hostId, entry) {
      const hostIdBytes = measureBoundedString(hostId, CONNECTION_LOG_HOST_ID_MAX_BYTES)
      const entryBytes = measureConnectionLogEntry(entry, maxEntryBytes)
      if (hostIdBytes === null || entryBytes === null || entryBytes > maxHostBytes) {
        return
      }
      let host = entriesByHost.get(hostId)
      if (!host) {
        while (entriesByHost.size >= maxRetainedHosts) {
          if (!evictOldestUnobservedHost()) {
            return
          }
        }
        const retainedHostKeyBytes = hostIdBytes + 128
        while (retainedStoreBytes + retainedHostKeyBytes + entryBytes > maxStoreBytes) {
          if (!evictOldestUnobservedHost()) {
            return
          }
        }
        host = { entries: [], bytes: retainedHostKeyBytes }
        entriesByHost.set(hostId, host)
        retainedStoreBytes += retainedHostKeyBytes
      } else {
        entriesByHost.delete(hostId)
        entriesByHost.set(hostId, host)
      }
      while (
        host.entries.length >= maxEntriesPerHost ||
        host.bytes + entryBytes > maxHostBytes ||
        retainedStoreBytes + entryBytes > maxStoreBytes
      ) {
        const oldest = host.entries.shift()
        if (oldest) {
          host.bytes -= oldest.bytes
          retainedStoreBytes -= oldest.bytes
          continue
        }
        if (!evictOldestUnobservedHost(hostId)) {
          break
        }
      }
      if (
        host.bytes + entryBytes > maxHostBytes ||
        retainedStoreBytes + entryBytes > maxStoreBytes
      ) {
        if (host.entries.length === 0) {
          deleteHost(hostId)
        }
        return
      }
      host.entries.push({ entry, bytes: entryBytes })
      host.bytes += entryBytes
      retainedStoreBytes += entryBytes
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
      const host = entriesByHost.get(hostId)
      if (!host || host.entries.length === 0) {
        return EMPTY
      }
      const snapshot = Object.freeze(host.entries.map((retained) => retained.entry))
      snapshotByHost.set(hostId, snapshot)
      return snapshot
    },

    subscribe(hostId, listener) {
      if (measureBoundedString(hostId, CONNECTION_LOG_HOST_ID_MAX_BYTES) === null) {
        return () => {}
      }
      let listeners = listenersByHost.get(hostId)
      if (!listeners) {
        if (listenersByHost.size >= maxRetainedHosts) {
          return () => {}
        }
        listeners = new Set()
        listenersByHost.set(hostId, listeners)
      }
      if (listeners.size >= CONNECTION_LOG_MAX_LISTENERS_PER_HOST) {
        return () => {}
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
    },

    delete(hostId) {
      deleteHost(hostId)
      const listeners = listenersByHost.get(hostId)
      if (listeners) {
        for (const listener of listeners) {
          listener()
        }
      }
    }
  }
}

export const connectionLogStore = createConnectionLogStore()
