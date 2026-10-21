import type { ConnectionLogEntry } from './types'
import { redactConnectionLogEntry } from '../diagnostics/connection-log-redaction'

// Why: the rpc-client's onLog entries were only wired during pairing; for
// long-lived host connections everything went to console.log, invisible to
// users. This buffer retains the recent lifecycle events per host so a
// "Connection log" screen (and copy-diagnostics) can show why a connection
// is stuck without a debug build. Module-level so the log survives client
// swaps (forceReconnect) and provider remounts (hot reload); bounded so an
// all-night reconnect loop can't grow memory unbounded.
const MAX_ENTRIES_PER_HOST = 200
// Why: a store that just rejected almost always rejects again on the same tick, so
// the one retry a snapshot gets waits instead of firing back-to-back.
const PERSISTENCE_RETRY_DELAY_MS = 200

export type ConnectionLogStore = {
  append: (hostId: string, entry: ConnectionLogEntry) => void
  flush: () => Promise<void>
  get: (hostId: string) => readonly ConnectionLogEntry[]
  hydrate: (hostId: string) => Promise<void>
  subscribe: (hostId: string, listener: () => void) => () => void
}

export type ConnectionLogPersistence = {
  load: (hostId: string) => Promise<readonly ConnectionLogEntry[]>
  save: (hostId: string, entries: readonly ConnectionLogEntry[]) => Promise<void>
}

export function createConnectionLogStore(
  maxEntriesPerHost: number = MAX_ENTRIES_PER_HOST,
  persistence?: ConnectionLogPersistence
): ConnectionLogStore {
  const entriesByHost = new Map<string, ConnectionLogEntry[]>()
  const listenersByHost = new Map<string, Set<() => void>>()
  const hydratedHosts = new Set<string>()
  const hydrationFailedHosts = new Set<string>()
  const hydrationByHost = new Map<string, Promise<void>>()
  const activeSaveByHost = new Map<string, Promise<void>>()
  const dirtyHosts = new Set<string>()
  const persistenceRevisionByHost = new Map<
    string,
    { snapshot: readonly ConnectionLogEntry[]; retried: boolean; saved: boolean }
  >()
  // Why: useSyncExternalStore compares snapshots by reference — getSnapshot
  // must return the SAME array until the data actually changes, or React
  // loops re-rendering. Cache per host; invalidate on append.
  const snapshotByHost = new Map<string, readonly ConnectionLogEntry[]>()
  const EMPTY: readonly ConnectionLogEntry[] = []

  const trim = (entries: ConnectionLogEntry[]): void => {
    if (entries.length > maxEntriesPerHost) {
      entries.splice(0, entries.length - maxEntriesPerHost)
    }
  }

  const notify = (hostId: string): void => {
    snapshotByHost.delete(hostId)
    persistenceRevisionByHost.delete(hostId)
    const listeners = listenersByHost.get(hostId)
    if (listeners) {
      for (const listener of listeners) {
        listener()
      }
    }
  }

  // Why: one in-flight save per host, re-reading the revision after each write, so
  // slow storage retains the in-flight snapshot and the newest pending one instead
  // of one superseded MAX_ENTRIES_PER_HOST copy per queued append.
  const runSaveLoop = async (hostId: string, storage: ConnectionLogPersistence): Promise<void> => {
    try {
      // Yield once so a synchronous append burst collapses into a single write.
      await Promise.resolve()
      while (dirtyHosts.delete(hostId)) {
        const revision = persistenceRevisionByHost.get(hostId)
        if (!revision || revision.saved) {
          return
        }
        try {
          await storage.save(hostId, revision.snapshot)
          revision.saved = true
        } catch {
          // At most one delayed retry per snapshot, and none at all once a newer
          // snapshot is queued — that snapshot already carries these entries, so
          // re-attempting this one is pure write amplification.
          if (!revision.retried && !dirtyHosts.has(hostId)) {
            revision.retried = true
            setTimeout(() => persist(hostId), PERSISTENCE_RETRY_DELAY_MS)
          }
        }
      }
    } finally {
      activeSaveByHost.delete(hostId)
    }
  }

  const persist = (hostId: string): void => {
    if (!persistence || !hydratedHosts.has(hostId)) {
      return
    }
    let revision = persistenceRevisionByHost.get(hostId)
    if (!revision) {
      revision = {
        snapshot: [...(entriesByHost.get(hostId) ?? [])],
        retried: false,
        saved: false
      }
      persistenceRevisionByHost.set(hostId, revision)
    }
    if (revision.saved) {
      return
    }
    dirtyHosts.add(hostId)
    if (activeSaveByHost.has(hostId)) {
      return
    }
    activeSaveByHost.set(hostId, runSaveLoop(hostId, persistence))
  }

  // Why: a failed write is otherwise only retried by the next append, so the final
  // entries explaining a disconnect are lost when the log goes quiet and the OS
  // kills the app. Two passes: drain whatever is running, then one retry.
  const flushHost = async (hostId: string): Promise<void> => {
    for (let pass = 0; pass < 2; pass++) {
      persist(hostId)
      const active = activeSaveByHost.get(hostId)
      if (!active) {
        return
      }
      await active
      if (persistenceRevisionByHost.get(hostId)?.saved === true) {
        return
      }
    }
  }

  const hydrateHost = async (hostId: string, retryAfterFailure: boolean): Promise<void> => {
    if (!persistence || hydratedHosts.has(hostId)) {
      return
    }
    const existing = hydrationByHost.get(hostId)
    if (existing) {
      return existing
    }
    if (!retryAfterFailure && hydrationFailedHosts.has(hostId)) {
      return
    }
    const pending = persistence
      .load(hostId)
      .then((stored) => {
        const live = entriesByHost.get(hostId) ?? []
        const seen = new Set<string>()
        const merged: ConnectionLogEntry[] = []
        for (const entry of [...stored, ...live]) {
          const redacted = redactConnectionLogEntry(entry)
          const fingerprint = JSON.stringify(redacted)
          if (!seen.has(fingerprint)) {
            seen.add(fingerprint)
            merged.push(redacted)
          }
        }
        merged.sort((a, b) => a.ts - b.ts)
        trim(merged)
        entriesByHost.set(hostId, merged)
        hydratedHosts.add(hostId)
        hydrationFailedHosts.delete(hostId)
        notify(hostId)
        persist(hostId)
      })
      .catch((error: unknown) => {
        hydrationFailedHosts.add(hostId)
        throw error
      })
      .finally(() => hydrationByHost.delete(hostId))
    hydrationByHost.set(hostId, pending)
    return pending
  }

  return {
    append(hostId, entry) {
      let entries = entriesByHost.get(hostId)
      if (!entries) {
        entries = []
        entriesByHost.set(hostId, entries)
      }
      entries.push(redactConnectionLogEntry(entry))
      trim(entries)
      notify(hostId)
      void hydrateHost(hostId, false)
        .then(() => persist(hostId))
        .catch(() => {})
    },

    flush: async () => {
      await Promise.all([...entriesByHost.keys()].map((hostId) => flushHost(hostId)))
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

    hydrate: (hostId) => hydrateHost(hostId, true),

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
