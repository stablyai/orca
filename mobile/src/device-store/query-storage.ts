import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { AsyncStorage, PersistedQuery } from '@tanstack/query-persist-client-core'
import {
  decodeDeviceStoreValue,
  DEVICE_STORE_MAX_VALUE_LENGTH,
  encodeDeviceStoreValue
} from './device-store-value-codec'

// The device store's cache table for one host: `native.store.rows` in a page, the store itself in native Home.
export type OrcaQueryStoreBackend = {
  // The page's bridge host, or the host native Home bound this storage to.
  readonly hostId: string
  read(
    keys: readonly string[]
  ): Promise<
    | { readonly status: 'ok'; readonly values: readonly (string | null)[] }
    | { readonly status: 'unavailable' }
  >
  write(
    ops: readonly { readonly key: string; readonly value: string | null }[]
  ): Promise<{ readonly written: boolean }>
}

// Holds records rather than strings so a refetch that kept the same data object can skip its write: the
// stored string always differs, since every fetch moves `dataUpdatedAt`. Persisters over it pass identity
// `serialize` and `deserialize`. No `entries()`: restore is by known key, and GC and wipes are the store's.
export type OrcaQueryStorage = AsyncStorage<PersistedQuery> & {
  // Writes what is pending now; for hidden, Back and app background.
  flush(): Promise<void>
}

const FLUSH_QUIET_MS = 300
const FLUSH_MAX_WAIT_MS = 2_000
// Unchanged data is still rewritten this long after the stored copy, so its saved time stays within a minute.
const SAME_DATA_REWRITE_MS = 60_000

type WrittenRecord = { readonly data: unknown; readonly buster: string; readonly updatedAt: number }

// The store key of a TanStack storage key. A queryHash carries worktree paths and query inputs, so it can
// pass the verb's 512-character key limit; a hash always fits. First-paint reads (Q4) map keys the same way.
export function orcaQueryStoreKey(storageKey: string): string {
  return bytesToHex(sha256(storageKey))
}

// A storage key is `<prefix>-<queryHash>`, and a queryHash is the queryKey's JSON. Anything unparseable
// is refused, so a record never lands under another host's wipe.
function keyNamesHost(storageKey: string, hostId: string): boolean {
  const hashAt = storageKey.indexOf('-[')
  if (hashAt === -1) {
    return false
  }
  try {
    const queryKey: unknown = JSON.parse(storageKey.slice(hashAt + 1))
    return Array.isArray(queryKey) && queryKey[0] === 'orca' && queryKey[1] === hostId
  } catch {
    return false
  }
}

function isPersistedRecord(value: unknown): value is PersistedQuery {
  return typeof value === 'object' && value !== null && 'queryHash' in value && 'state' in value
}

function encodeForStore(query: PersistedQuery): string | null {
  try {
    const value = encodeDeviceStoreValue(query)
    return value.length > DEVICE_STORE_MAX_VALUE_LENGTH ? null : value
  } catch {
    return null
  }
}

export function createOrcaQueryStorage(backend: OrcaQueryStoreBackend): OrcaQueryStorage {
  // Latest record per key since the last flush; null removes the row.
  const pending = new Map<string, PersistedQuery | null>()
  const written = new Map<string, WrittenRecord>()
  let firstPendingAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<void> = Promise.resolve()

  const schedule = (): void => {
    const now = Date.now()
    firstPendingAt ??= now
    if (timer !== null) {
      clearTimeout(timer)
    }
    const delay = Math.min(FLUSH_QUIET_MS, firstPendingAt + FLUSH_MAX_WAIT_MS - now)
    timer = setTimeout(() => void flush(), Math.max(0, delay))
  }

  const isAlreadyWritten = (key: string, query: PersistedQuery): boolean => {
    const last = written.get(key)
    return (
      last !== undefined &&
      last.data === query.state.data &&
      last.buster === query.buster &&
      query.state.dataUpdatedAt - last.updatedAt < SAME_DATA_REWRITE_MS
    )
  }

  const writePending = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    firstPendingAt = null
    const now = Date.now()
    for (const [key, last] of written) {
      if (now - last.updatedAt >= SAME_DATA_REWRITE_MS) {
        written.delete(key)
      }
    }
    const ops: { key: string; value: string | null }[] = []
    const sent = new Map<string, WrittenRecord | null>()
    for (const [key, query] of pending) {
      if (query !== null && isAlreadyWritten(key, query)) {
        continue
      }
      // A record too large or unencodable removes the stored one, which is older than memory, and is
      // remembered like a write so a refetch of the same data doesn't encode it again.
      const value = query === null ? null : encodeForStore(query)
      ops.push({ key: orcaQueryStoreKey(key), value })
      sent.set(
        key,
        query === null
          ? null
          : { data: query.state.data, buster: query.buster, updatedAt: query.state.dataUpdatedAt }
      )
    }
    pending.clear()
    if (ops.length === 0) {
      return
    }
    // A failed write must not reject: the flush chain would stop every later flush.
    let stored = false
    try {
      stored = (await backend.write(ops)).written
    } catch {
      stored = false
    }
    for (const [key, record] of sent) {
      // After a refusal the next persist of these keys writes again.
      if (stored && record !== null) {
        written.set(key, record)
      } else {
        written.delete(key)
      }
    }
  }

  // Flushes run one at a time so a key's writes reach the store in order.
  const flush = (): Promise<void> => {
    flushing = flushing.then(writePending)
    return flushing
  }

  return {
    async getItem(key) {
      if (pending.has(key)) {
        return pending.get(key) ?? null
      }
      const read = await backend.read([orcaQueryStoreKey(key)])
      const value = read.status === 'ok' ? read.values[0] : null
      if (value == null) {
        return null
      }
      // A throw makes TanStack remove the row; it checks the rest of the record's shape itself.
      const record = decodeDeviceStoreValue(value)
      if (!isPersistedRecord(record)) {
        throw new Error('[query-storage] unreadable stored record')
      }
      return record
    },
    setItem(key, query) {
      if (!keyNamesHost(key, backend.hostId)) {
        console.warn('[query-storage] refused a record outside this host', key)
        return
      }
      pending.set(key, query)
      schedule()
    },
    removeItem(key) {
      pending.set(key, null)
      schedule()
    },
    flush
  }
}
