import type { ConnectionLogEntry } from './types'
import { redactConnectionLogEntry } from '../diagnostics/connection-log-redaction'

const MAX_ENTRIES_PER_HOST = 200

export type ConnectionLogStore = {
  append: (hostId: string, entry: ConnectionLogEntry) => void
  get: (hostId: string) => readonly ConnectionLogEntry[]
  hydrate: (hostId: string) => Promise<void>
  subscribe: (hostId: string, listener: () => void) => () => void
  forgetHost: (hostId: string) => Promise<void>
}

export type ConnectionLogPersistence = {
  load: (hostId: string) => Promise<readonly ConnectionLogEntry[]>
  save: (hostId: string, entries: readonly ConnectionLogEntry[]) => Promise<void>
  remove: (hostId: string) => Promise<void>
}

type HostLog = {
  entries: ConnectionLogEntry[]
  snapshot?: readonly ConnectionLogEntry[]
  hydrated?: boolean
  hydrationFailed?: boolean
  hydration?: Promise<void>
}

export function createConnectionLogStore(
  maxEntriesPerHost: number = MAX_ENTRIES_PER_HOST,
  persistence?: ConnectionLogPersistence
): ConnectionLogStore {
  const logsByHost = new Map<string, HostLog>()
  const listenersByHost = new Map<string, Set<() => void>>()
  const writesByHost = new Map<string, Promise<void>>()
  const EMPTY: readonly ConnectionLogEntry[] = []

  const getLog = (hostId: string): HostLog => {
    let log = logsByHost.get(hostId)
    if (!log) {
      log = { entries: [] }
      logsByHost.set(hostId, log)
    }
    return log
  }

  const trim = (entries: ConnectionLogEntry[]): void => {
    if (entries.length > maxEntriesPerHost) {
      entries.splice(0, entries.length - maxEntriesPerHost)
    }
  }

  const notify = (hostId: string): void => {
    const listeners = listenersByHost.get(hostId)
    if (listeners) {
      for (const listener of listeners) {
        listener()
      }
    }
  }

  const enqueueWrite = (hostId: string, write: () => Promise<void>): Promise<void> => {
    const previous = writesByHost.get(hostId) ?? Promise.resolve()
    const pending = previous
      .catch(() => {})
      .then(async () => {
        try {
          await write()
        } catch {
          await write()
        }
      })
      .finally(() => {
        if (writesByHost.get(hostId) === pending) {
          writesByHost.delete(hostId)
        }
      })
    writesByHost.set(hostId, pending)
    return pending
  }

  const persist = (hostId: string, log: HostLog): void => {
    if (!persistence || !log.hydrated || logsByHost.get(hostId) !== log) {
      return
    }
    const snapshot = [...log.entries]
    void enqueueWrite(hostId, async () => {
      if (logsByHost.get(hostId) === log) {
        await persistence.save(hostId, snapshot)
      }
    }).catch(() => {})
  }

  const hydrateHost = async (
    hostId: string,
    log: HostLog,
    retryAfterFailure: boolean
  ): Promise<void> => {
    if (!persistence || log.hydrated || logsByHost.get(hostId) !== log) {
      return
    }
    if (log.hydration) {
      return log.hydration
    }
    if (!retryAfterFailure && log.hydrationFailed) {
      return
    }
    // Re-pairing must wait for retirement writes before reading persisted history.
    const writes = writesByHost.get(hostId)
    const loaded = writes ? writes.then(() => persistence.load(hostId)) : persistence.load(hostId)
    const pending = loaded
      .then((stored) => {
        if (logsByHost.get(hostId) !== log) {
          return
        }
        const seen = new Set<string>()
        const merged: ConnectionLogEntry[] = []
        for (const entry of [...stored, ...log.entries]) {
          const redacted = redactConnectionLogEntry(entry)
          const fingerprint = JSON.stringify(redacted)
          if (!seen.has(fingerprint)) {
            seen.add(fingerprint)
            merged.push(redacted)
          }
        }
        merged.sort((a, b) => a.ts - b.ts)
        trim(merged)
        log.entries = merged
        log.snapshot = undefined
        log.hydrated = true
        log.hydrationFailed = false
        notify(hostId)
        persist(hostId, log)
      })
      .catch((error: unknown) => {
        log.hydrationFailed = true
        throw error
      })
      .finally(() => {
        log.hydration = undefined
      })
    log.hydration = pending
    return pending
  }

  return {
    append(hostId, entry) {
      const log = getLog(hostId)
      log.entries.push(redactConnectionLogEntry(entry))
      trim(log.entries)
      log.snapshot = undefined
      notify(hostId)
      void hydrateHost(hostId, log, false)
        .then(() => persist(hostId, log))
        .catch(() => {})
    },

    get(hostId) {
      const log = logsByHost.get(hostId)
      if (!log || log.entries.length === 0) {
        return EMPTY
      }
      // useSyncExternalStore requires a stable reference until the log changes.
      log.snapshot ??= Object.freeze([...log.entries])
      return log.snapshot
    },

    hydrate: (hostId) => hydrateHost(hostId, getLog(hostId), true),

    forgetHost(hostId) {
      logsByHost.delete(hostId)
      // Queue removal before notifying subscribers, which may start a new hydration.
      const removed = persistence
        ? enqueueWrite(hostId, () => persistence.remove(hostId))
        : Promise.resolve()
      notify(hostId)
      return removed
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
