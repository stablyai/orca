import { useCallback, useSyncExternalStore } from 'react'
import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/accounts-snapshot'
import { subscribeAccountsSnapshots } from '../accounts/accounts-snapshot-stream'
import type { RpcClient } from '../transport/rpc-client'

type Entry = {
  snapshot: AccountsSnapshot | null
  listeners: Set<() => void>
  stop: (() => void) | null
  stopTimer: ReturnType<typeof setTimeout> | null
}

// Tab switches unmount one composer and mount the next; a short grace keeps the stream open across them.
const STOP_GRACE_MS = 2_000

// One stream per client however many composers show usage; the last snapshot survives a pause.
const entries = new WeakMap<RpcClient, Entry>()

function entryFor(client: RpcClient): Entry {
  let entry = entries.get(client)
  if (!entry) {
    entry = { snapshot: null, listeners: new Set(), stop: null, stopTimer: null }
    entries.set(client, entry)
  }
  return entry
}

function startStream(client: RpcClient, entry: Entry): () => void {
  let stopped = false
  const accept = (snapshot: AccountsSnapshot): void => {
    entry.snapshot = snapshot
    for (const listener of entry.listeners) {
      listener()
    }
  }
  const unsubscribe = subscribeAccountsSnapshots(client, {
    onSnapshot: accept,
    onInvalidSnapshot: () => undefined,
    onStreamError: () => undefined
  })
  // Hosts without the stream still answer the one-shot list; a streamed snapshot is never older.
  void client.sendRequest('accounts.list').then(
    (res) => {
      if (stopped || entry.snapshot !== null || !res.ok) {
        return
      }
      try {
        accept(decodeAccountsSnapshot(res.result))
      } catch {
        // An undecodable list leaves the meter hidden.
      }
    },
    () => undefined
  )
  return () => {
    stopped = true
    unsubscribe()
  }
}

export function subscribeAccountsSnapshot(client: RpcClient, listener: () => void): () => void {
  const entry = entryFor(client)
  entry.listeners.add(listener)
  if (entry.stopTimer !== null) {
    clearTimeout(entry.stopTimer)
    entry.stopTimer = null
  }
  entry.stop ??= startStream(client, entry)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size > 0 || entry.stopTimer !== null) {
      return
    }
    entry.stopTimer = setTimeout(() => {
      entry.stopTimer = null
      if (entry.listeners.size === 0) {
        entry.stop?.()
        entry.stop = null
      }
    }, STOP_GRACE_MS)
  }
}

const NO_SUBSCRIPTION = (): (() => void) => () => undefined

/** The host's accounts snapshot, shared by every caller on the same client; null while unknown. */
export function useAccountsSnapshot(client: RpcClient | null): AccountsSnapshot | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      client ? subscribeAccountsSnapshot(client, listener) : NO_SUBSCRIPTION(),
    [client]
  )
  const read = useCallback(
    () => (client ? (entries.get(client)?.snapshot ?? null) : null),
    [client]
  )
  return useSyncExternalStore(subscribe, read, read)
}
