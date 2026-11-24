import {
  experimental_createQueryPersister,
  type PersistedQuery
} from '@tanstack/query-persist-client-core'
import { hashKey, replaceEqualDeep, type Query, type QueryClient } from '@tanstack/react-query'
import type * as z from 'zod'
import {
  createOrcaQueryStorage,
  orcaQueryStoreKey,
  type OrcaQueryStoreBackend
} from '../device-store/query-storage'
import type { HostQueryKey } from './host-query-key'

/** How a family's data is kept on the phone between launches. A family without it stays in memory. */
export type HostQueryPersist<TData> = {
  // Bump when the stored shape changes: records of another version are never read.
  version: number
  // Checks restored data; a record that fails it is removed, never shown.
  dataSchema: z.ZodType<TData, unknown>
  // Drops what must never paint from disk, such as live agent attention (K1), before the write.
  strip?: (data: TData) => TData
}

/** A family as persistence sees it: its name and storage rules. */
export type PersistedHostFamily<TData> = {
  family: string
  persist?: HostQueryPersist<TData>
}

/** A key to restore, with the family whose rules apply to it. */
export type PersistedHostQueryKey = {
  queryKey: HostQueryKey
  persist: HostQueryPersist<unknown>
}

export function persistedHostQueryKey<TData>(
  family: PersistedHostFamily<TData>,
  queryKey: HostQueryKey
): PersistedHostQueryKey | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the record under this key was written from the same family's data, and its dataSchema checks it on restore.
  return family.persist ? { queryKey, persist: family.persist as HostQueryPersist<unknown> } : null
}

function hostQueryPersistOf(query: Query): HostQueryPersist<unknown> | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hostQueryOptions and session.tabs write `persist` from the family's HostQueryPersist.
  return query.meta?.persist as HostQueryPersist<unknown> | undefined
}

// Per world, the keys whose data came from the store and no read has replaced yet.
const restoredKeys = new WeakMap<QueryClient, Set<string>>()
// Per world, a store per host: one in a page document, one per paired host in native Home. Absent keeps memory only.
const persistences = new WeakMap<QueryClient, Map<string, HostQueryPersistence>>()

function restoredKeysOf(queryClient: QueryClient): Set<string> {
  let keys = restoredKeys.get(queryClient)
  if (!keys) {
    keys = new Set()
    restoredKeys.set(queryClient, keys)
  }
  return keys
}

/**
 * Whether a key still holds what an earlier launch stored: shown, but possibly days old and unconfirmed by
 * any read in this document. Fetches are told so (`previousFromStore`).
 */
export function holdsRestoredHostQueryData(queryClient: QueryClient, queryHash: string): boolean {
  return restoredKeys.get(queryClient)?.has(queryHash) === true
}

// TanStack's storage key is `<prefix>-<queryHash>`; the version keeps old shapes from ever being read.
function familyPrefix(family: string, persist: HostQueryPersist<unknown>): string {
  return `q1|${family}@${persist.version}`
}

// Stored data of any age paints (silently while online); this only bounds what a forgotten host leaves.
const STORED_FOR_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Restores stored keys a screen reads without observing them (its inputs come from its own state).
 * Resolves once each is applied or missed; at once where nothing is stored.
 */
export function restoreStoredHostQueries(
  queryClient: QueryClient,
  keys: readonly PersistedHostQueryKey[]
): Promise<void> {
  const byHost = persistences.get(queryClient)
  const hostIds = new Set(keys.map((key) => key.queryKey[1]))
  return Promise.all(
    [...hostIds].map(
      (hostId) =>
        byHost?.get(hostId)?.restore(keys.filter((key) => key.queryKey[1] === hostId)) ??
        Promise.resolve()
    )
  ).then(() => undefined)
}

/** This world's store for one host, if it keeps one. */
export function hostQueryPersistenceOf(
  queryClient: QueryClient,
  hostId: string
): HostQueryPersistence | undefined {
  return persistences.get(queryClient)?.get(hostId)
}

export type HostQueryPersistence = {
  // Restores keys that hold no data yet, from one store read; resolves once each is applied or missed.
  restore(keys: readonly PersistedHostQueryKey[]): Promise<void>
  // Writes what is pending now; for hidden and page close.
  flush(): Promise<void>
  // Stops writing this host's queries, as when the host is removed; writes already pending still flush.
  stop(): void
}

// The boot read fetches every first-paint key in one store call; each key's later getItem takes its value once.
function primedBackend(backend: OrcaQueryStoreBackend) {
  const primed = new Map<string, string | null>()
  return {
    async prime(keys: readonly string[]): Promise<void> {
      if (keys.length === 0) {
        return
      }
      const read = await backend.read(keys)
      if (read.status === 'ok') {
        keys.forEach((key, at) => primed.set(key, read.values[at] ?? null))
      }
    },
    backend: {
      hostId: backend.hostId,
      read: async (keys: readonly string[]) => {
        const [key] = keys
        if (keys.length === 1 && key !== undefined && primed.has(key)) {
          const value = primed.get(key) ?? null
          primed.delete(key)
          return { status: 'ok' as const, values: [value] }
        }
        return backend.read(keys)
      },
      write: (ops: readonly { readonly key: string; readonly value: string | null }[]) => {
        for (const op of ops) {
          primed.delete(op.key)
        }
        return backend.write(ops)
      }
    } satisfies OrcaQueryStoreBackend
  }
}

export function createHostQueryPersistence(
  queryClient: QueryClient,
  store: OrcaQueryStoreBackend
): HostQueryPersistence {
  const byHost = persistences.get(queryClient) ?? new Map<string, HostQueryPersistence>()
  persistences.set(queryClient, byHost)
  const primer = primedBackend(store)
  const storage = createOrcaQueryStorage(primer.backend)
  const persisters = new Map<string, ReturnType<typeof createFamilyPersister>>()
  // The newest dataUpdatedAt each key was persisted or restored with: a restore never writes itself back.
  const settledAt = new Map<string, number>()
  // The last data written per key and what it was stored as, so unchanged data keeps one stored object.
  const lastStored = new Map<string, { readonly source: unknown; readonly stored: unknown }>()
  // One store read per key at a time; a second caller waits on the first.
  const restoring = new Map<string, Promise<void>>()
  // Keys a restore found empty: neither the screen's first observer nor a later restore reads them again.
  const missedAtBoot = new Set<string>()
  const triedOnMiss = new WeakSet<Query>()
  const restored = restoredKeysOf(queryClient)
  // The key a restore is writing, so its own success leaves the mark.
  let applyingRestore: string | null = null

  function storedData(queryHash: string, data: unknown, persist: HostQueryPersist<unknown>) {
    const last = lastStored.get(queryHash)
    if (last !== undefined && last.source === data) {
      return last.stored
    }
    const stripped = persist.strip ? persist.strip(data) : data
    // Same content as the last write keeps its object, which the storage skips writing again.
    const stored = replaceEqualDeep(last?.stored, stripped)
    lastStored.set(queryHash, { source: data, stored })
    return stored
  }

  function createFamilyPersister(family: string, persist: HostQueryPersist<unknown>) {
    return experimental_createQueryPersister<PersistedQuery>({
      storage,
      prefix: familyPrefix(family, persist),
      maxAge: STORED_FOR_MS,
      serialize: (record) => ({
        ...record,
        state: {
          ...record.state,
          data: storedData(record.queryHash, record.state.data, persist),
          error: null,
          fetchFailureReason: null
        }
      }),
      // A throw makes TanStack remove the record.
      deserialize: (record) => ({
        ...record,
        state: { ...record.state, data: persist.dataSchema.parse(record.state.data) }
      })
    })
  }

  function persisterFor(family: string, persist: HostQueryPersist<unknown>) {
    const prefix = familyPrefix(family, persist)
    let persister = persisters.get(prefix)
    if (!persister) {
      persister = createFamilyPersister(family, persist)
      persisters.set(prefix, persister)
    }
    return persister
  }

  function familyOf(queryKey: readonly unknown[]): string | null {
    const [scope, hostId, family] = queryKey
    return scope === 'orca' && hostId === store.hostId && typeof family === 'string' ? family : null
  }

  // Applied only to a key still empty: a live answer that landed first always wins. `after` is the boot
  // batch read: the key is claimed now, so an observer arriving meanwhile joins instead of reading again.
  function restoreOne(
    queryKey: readonly unknown[],
    persist: HostQueryPersist<unknown>,
    after: Promise<void> = Promise.resolve()
  ) {
    const family = familyOf(queryKey)
    const queryHash = hashKey(queryKey)
    if (family === null) {
      return Promise.resolve()
    }
    const pending = restoring.get(queryHash)
    if (pending) {
      return pending
    }
    const restore = new Promise<void>((settle) => {
      void after
        .then(() =>
          persisterFor(family, persist).retrieveQuery(queryHash, (record) => {
            if (queryClient.getQueryData(queryKey) === undefined) {
              const { data, dataUpdatedAt } = record.state
              settledAt.set(queryHash, dataUpdatedAt)
              // Marked first: listeners told of this write must already see it as an earlier launch's.
              restored.add(queryHash)
              applyingRestore = queryHash
              try {
                queryClient.setQueryData(queryKey, data, { updatedAt: dataUpdatedAt })
              } finally {
                applyingRestore = null
              }
            }
            settle()
          })
        )
        .then(
          (data) => {
            // A restored record settles in the scheduled callback above.
            if (data === undefined) {
              settle()
            }
          },
          () => settle()
        )
    }).finally(() => restoring.delete(queryHash))
    restoring.set(queryHash, restore)
    return restore
  }

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    const { query } = event
    const persist = hostQueryPersistOf(query)
    if (!persist || familyOf(query.queryKey) === null) {
      return
    }
    // An observed key with no data, such as one past its gcTime, reads its record once beside the fetch.
    if (event.type === 'observerAdded') {
      if (
        query.state.data === undefined &&
        !triedOnMiss.has(query) &&
        !missedAtBoot.delete(query.queryHash)
      ) {
        triedOnMiss.add(query)
        void restoreOne(query.queryKey, persist)
      }
      return
    }
    if (event.type === 'removed') {
      settledAt.delete(query.queryHash)
      lastStored.delete(query.queryHash)
      restored.delete(query.queryHash)
      missedAtBoot.delete(query.queryHash)
      return
    }
    // Fetches and setQueryData both land as success; only data newer than what the key holds on disk is written.
    if (event.type !== 'updated' || event.action.type !== 'success') {
      return
    }
    // Any write but the restore's own is this launch's, whatever its clock says; a listener's write during it included.
    if (query.queryHash === applyingRestore) {
      applyingRestore = null
    } else {
      restored.delete(query.queryHash)
    }
    const family = familyOf(query.queryKey)
    const at = query.state.dataUpdatedAt
    if (family === null || at <= (settledAt.get(query.queryHash) ?? 0)) {
      return
    }
    settledAt.set(query.queryHash, at)
    void persisterFor(family, persist).persistQuery(query)
  })

  const persistence: HostQueryPersistence = {
    async restore(keys) {
      const empty = keys.flatMap((key) => {
        const family = familyOf(key.queryKey)
        return family !== null &&
          queryClient.getQueryData(key.queryKey) === undefined &&
          !missedAtBoot.has(hashKey(key.queryKey))
          ? [{ ...key, family }]
          : []
      })
      // A key already being read joins that read below instead of reading again.
      const primed = primer.prime(
        empty.flatMap(({ queryKey, persist, family }) =>
          restoring.has(hashKey(queryKey))
            ? []
            : [orcaQueryStoreKey(`${familyPrefix(family, persist)}-${hashKey(queryKey)}`)]
        )
      )
      const batchRead = primed.catch(() => undefined)
      await Promise.all(
        empty.map(async ({ queryKey, persist }) => {
          await restoreOne(queryKey, persist, batchRead)
          if (queryClient.getQueryData(queryKey) === undefined) {
            missedAtBoot.add(hashKey(queryKey))
          }
        })
      )
    },
    flush: () => storage.flush(),
    stop() {
      unsubscribe()
      if (byHost.get(store.hostId) === persistence) {
        byHost.delete(store.hostId)
      }
    }
  }
  byHost.get(store.hostId)?.stop()
  byHost.set(store.hostId, persistence)
  return persistence
}
