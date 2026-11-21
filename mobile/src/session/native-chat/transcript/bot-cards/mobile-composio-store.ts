// A bot's Composio as its chat's setup cards read it, like the computer's composio-client: the key's state
// and the bot's sign-ins, one read per bot however many cards show, again on the host's notices, a
// reconnect or the foreground (so a sign-in finished in the browser shows on return).
import { useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { startHostBotRefresh } from '../../../../bots/host-bot-refresh'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { composioConnectionsRead, composioStatusRead } from './mobile-composio-operations'

export type MobileComposio = {
  status: { key: string; added: boolean } | null
  /** Null until read and while no key is saved; a failed read keeps the last. */
  connections: {
    connections: { app: string; status: string; label: string | null }[]
    pending: { app: string; url: string }[]
  } | null
}

const EMPTY: MobileComposio = { status: null, connections: null }

type Entry = {
  client: RpcClient
  botId: string
  view: MobileComposio
  readers: number
  stop: (() => void) | null
  /** The host answered a status read once; until then the refresh keeps polling. */
  replied: boolean
  /** One read at a time; a refresh asked for meanwhile runs once after it, so a slow host still lands. */
  reading: boolean
  again: boolean
}

// By `hostKey` and bot id.
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

const keyOf = (hostKey: string, botId: string): string => `${hostKey}\u0000${botId}`

async function readOnce(entry: Entry): Promise<MobileComposio | null> {
  const { client, botId } = entry
  const status = await composioStatusRead
    .request(client, { botId })
    .then((response) => composioStatusRead.interpret(response))
    .catch(() => null)
  // Unread, the card keeps what it last read and the refresh asks again.
  if (!status) {
    return null
  }
  let connections = status.key === 'none' ? null : entry.view.connections
  if (status.key === 'ok') {
    connections = await composioConnectionsRead
      .request(client, { botId })
      .then((response) => composioConnectionsRead.interpret(response))
      .catch(() => connections)
  }
  return { status, connections }
}

async function read(key: string): Promise<void> {
  const entry = entries.get(key)
  if (!entry) {
    return
  }
  if (entry.reading) {
    entry.again = true
    return
  }
  entry.reading = true
  try {
    do {
      entry.again = false
      const view = await readOnce(entry)
      if (entries.get(key) !== entry) {
        return
      }
      if (view) {
        entry.replied = true
        entry.view = view
        for (const listener of listeners) {
          listener()
        }
      }
    } while (entry.again)
  } finally {
    entry.reading = false
  }
}

function attach(key: string, client: RpcClient, botId: string): () => void {
  let entry = entries.get(key)
  if (entry && entry.client !== client) {
    entry.stop?.()
    entries.delete(key)
    entry = undefined
  }
  if (!entry) {
    entry = {
      client,
      botId,
      view: EMPTY,
      readers: 0,
      stop: null,
      replied: false,
      reading: false,
      again: false
    }
    entries.set(key, entry)
  }
  const attached = entry
  attached.readers += 1
  // The refresh reads once as it starts.
  if (!attached.stop) {
    attached.stop = startHostBotRefresh({
      client,
      appState: AppState,
      refresh: () => void read(key),
      listed: () => attached.replied,
      // As the computer's cards: Composio changes are settings notices, a bot edit a bot one.
      interest: () => ({ botId, kinds: ['settings', 'bot'] })
    })
  }
  return () => {
    attached.readers -= 1
    if (attached.readers === 0) {
      attached.stop?.()
      attached.stop = null
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useMobileComposio(
  client: RpcClient | null,
  hostKey: string | null,
  botId: string
): MobileComposio {
  const key = hostKey ? keyOf(hostKey, botId) : null
  useEffect(() => (client && key ? attach(key, client, botId) : undefined), [client, key, botId])
  return useSyncExternalStore(subscribe, () => (key ? entries.get(key)?.view : null) ?? EMPTY)
}

/** Reads the bot again after a change made from this phone. */
export function rereadMobileComposio(hostKey: string, botId: string): void {
  void read(keyOf(hostKey, botId))
}
