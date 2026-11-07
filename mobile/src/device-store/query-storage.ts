import type { AsyncStorage, PersistedQuery } from '@tanstack/query-persist-client-core'
import {
  decodePersistedQuery,
  encodePersistedQuery,
  PERSISTED_QUERY_MAX_ENCODED_LENGTH
} from './persisted-query-codec'

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

// `native.store.rows` refuses a longer key, and with it every other write in the call.
const STORE_KEY_MAX_LENGTH = 512

type WrittenRecord = { readonly data: unknown; readonly buster: string; readonly updatedAt: number }

// A storage key is `<prefix>-<queryHash>`, and a queryHash is the queryKey's JSON. Anything unparseable
// is refused, so a record never lands under another host's wipe; so is a key the verb would refuse.
function isStorableKey(storageKey: string, hostId: string): boolean {
  const hashAt = storageKey.indexOf('-[')
  if (hashAt === -1 || storageKey.length > STORE_KEY_MAX_LENGTH) {
    return false
  }
  try {
    const queryKey: unknown = JSON.parse(storageKey.slice(hashAt + 1))
    return Array.isArray(queryKey) && queryKey[0] === 'orca' && queryKey[1] === hostId
  } catch {
    return false
  }
}

function encodeForStore(query: PersistedQuery): string | null {
  try {
    const value = encodePersistedQuery(query)
    return value.length > PERSISTED_QUERY_MAX_ENCODED_LENGTH ? null : value
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
      // A record too large or unencodable removes the stored one, which is older than memory.
      const value = query === null ? null : encodeForStore(query)
      ops.push({ key, value })
      sent.set(
        key,
        query === null || value === null
          ? null
          : { data: query.state.data, buster: query.buster, updatedAt: query.state.dataUpdatedAt }
      )
    }
    pending.clear()
    if (ops.length === 0) {
      return
    }
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
      const read = await backend.read([key])
      const value = read.status === 'ok' ? read.values[0] : null
      return value == null ? null : decodePersistedQuery(value)
    },
    setItem(key, query) {
      if (!isStorableKey(key, backend.hostId)) {
        console.warn(
          '[query-storage] refused a record outside this host or over the key limit',
          key
        )
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
