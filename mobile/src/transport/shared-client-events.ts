import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import type { RpcClient } from './rpc-client'

type WireReady = Extract<RuntimeClientEventStreamMessage, { type: 'ready' }>

export type SharedClientEvent =
  | Exclude<RuntimeClientEventStreamMessage, { type: 'ready' }>
  | WireReady
  // Joined a stream already live on this connection: no snapshot and no per-subscription replay come.
  | { type: 'ready'; joined: true }
  | { type: 'error'; message?: string }

export type SharedClientEventListener = (event: SharedClientEvent) => void

export type SharedClientEventsClient = Pick<
  RpcClient,
  'subscribe' | 'getState' | 'getLastConnectedAt' | 'getGeneration'
>

type SharedStream = {
  listeners: Set<{ listener: SharedClientEventListener }>
  stop: (() => void) | null
  // The connection the last wire `ready` arrived on; null until one does.
  readyOn: string | null
}

const streams = new WeakMap<SharedClientEventsClient, SharedStream>()

/**
 * One `runtime.clientEvents` wire stream per client, shared by every listener in this JS world.
 * Every wire event reaches every listener; a listener that joins after the wire's `ready` on the
 * current connection gets a `joined` ready instead. The stream closes once its last listener leaves.
 */
export function subscribeSharedClientEvents(
  client: SharedClientEventsClient,
  listener: SharedClientEventListener
): () => void {
  const subscription = { listener }
  const existing = streams.get(client)
  const stream = existing ?? { listeners: new Set(), stop: null, readyOn: null }
  stream.listeners.add(subscription)
  if (existing) {
    // Deferred like a wire reply, so a caller never hears back before subscribe returns.
    queueMicrotask(() => {
      if (
        stream.listeners.has(subscription) &&
        stream.readyOn !== null &&
        stream.readyOn === connectionKey(client)
      ) {
        listener({ type: 'ready', joined: true })
      }
    })
  } else {
    streams.set(client, stream)
    let stop: () => void
    try {
      stop = client.subscribe('runtime.clientEvents.subscribe', null, (payload) =>
        deliver(client, stream, payload)
      )
    } catch (error) {
      // A page bridge throws when it can't open a stream; later subscribers must retry the wire.
      if (streams.get(client) === stream) {
        streams.delete(client)
      }
      throw error
    }
    if (streams.get(client) === stream) {
      stream.stop = stop
    } else {
      // The wire refused synchronously and the stream already ended.
      stop()
    }
  }
  return () => {
    if (!stream.listeners.delete(subscription) || stream.listeners.size > 0) {
      return
    }
    // An effect that re-runs leaves and rejoins in one commit; keep the wire stream across it.
    queueMicrotask(() => {
      if (stream.listeners.size > 0) {
        return
      }
      if (streams.get(client) === stream) {
        streams.delete(client)
      }
      stream.stop?.()
      stream.stop = null
    })
  }
}

function deliver(client: SharedClientEventsClient, stream: SharedStream, payload: unknown): void {
  if (!isEvent(payload)) {
    return
  }
  if (payload.type === 'ready') {
    stream.readyOn = connectionKey(client)
  } else if (payload.type === 'end' || payload.type === 'error') {
    // The wire stream is over; the next subscriber opens a fresh one.
    if (streams.get(client) === stream) {
      streams.delete(client)
    }
    stream.readyOn = null
  }
  let failure: { error: unknown } | null = null
  // Snapshot: a listener added mid-dispatch hears its own joined ready, not this event too.
  for (const subscription of Array.from(stream.listeners)) {
    if (!stream.listeners.has(subscription)) {
      continue
    }
    try {
      subscription.listener(payload)
    } catch (error) {
      // One throwing consumer must not starve the rest; rethrow to the transport afterwards.
      failure ??= { error }
    }
  }
  if (failure) {
    throw failure.error
  }
}

function isEvent(payload: unknown): payload is SharedClientEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    typeof payload.type === 'string'
  )
}

// A reconnect stamps a new connected time and a migration a new generation; either is a new connection.
function connectionKey(client: SharedClientEventsClient): string | null {
  if (client.getState() !== 'connected') {
    return null
  }
  return `${client.getGeneration?.() ?? 0}:${client.getLastConnectedAt() ?? ''}`
}
