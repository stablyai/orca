import type { RuntimeClientEventStreamMessage } from '../../../../src/shared/runtime-client-events'
import type { RpcClient } from '../rpc/rpc-client-contract'
import { hostConnectionEpoch } from '../../query/host-status-query'

type WireReady = Extract<RuntimeClientEventStreamMessage, { type: 'ready' }>

export type SharedClientEvent =
  | Exclude<RuntimeClientEventStreamMessage, { type: 'ready' }>
  // `replayed`: this listener heard a ready before, so events since then may have been missed.
  | (WireReady & { replayed?: true })
  // Joined a stream already live on this connection: no snapshot and no per-subscription replay come.
  | { type: 'ready'; joined: true }
  | { type: 'error'; message?: string }

export type SharedClientEventListener = (event: SharedClientEvent) => void

export type SharedClientEventsClient = Pick<
  RpcClient,
  'subscribe' | 'getState' | 'getLastConnectedAt' | 'getGeneration' | 'onStateChange'
>

// One `runtime.clientEvents.subscribe` on the transport; payloads from a wire that is no longer current are dropped.
type Wire = {
  stop: (() => void) | null
  ready: boolean
  // The connection this wire's last `ready` arrived on.
  readyOn: string | null
}

type Subscription = { listener: SharedClientEventListener; heardReady: boolean }

type SharedStream = {
  listeners: Set<Subscription>
  wire: Wire | null
  // A wire that failed before its ready opens again on the next connected edge, not in the same one.
  stopWatching: () => void
}

const streams = new WeakMap<SharedClientEventsClient, SharedStream>()

/**
 * One `runtime.clientEvents` wire stream per client, shared by every listener in this JS world.
 * Every wire event reaches every listener; a listener that joins after the wire's `ready` on the
 * current connection gets a `joined` ready instead. When the wire ends or fails, listeners hear it
 * and the stream opens a fresh wire for them; its `ready` comes `replayed`, since events were missed.
 * The stream closes once its last listener leaves.
 */
export function subscribeSharedClientEvents(
  client: SharedClientEventsClient,
  listener: SharedClientEventListener
): () => void {
  const subscription: Subscription = { listener, heardReady: false }
  const joined = streams.get(client) ?? createStream(client)
  joined.listeners.add(subscription)
  if (joined.wire) {
    // Deferred like a wire reply, so a caller never hears back before subscribe returns.
    queueMicrotask(() => {
      const readyOn = joined.wire?.readyOn ?? null
      if (
        joined.listeners.has(subscription) &&
        readyOn !== null &&
        readyOn === connectionKey(client)
      ) {
        subscription.heardReady = true
        listener({ type: 'ready', joined: true })
      }
    })
  } else {
    openWire(client, joined)
  }
  return () => {
    if (!joined.listeners.delete(subscription) || joined.listeners.size > 0) {
      return
    }
    // An effect that re-runs leaves and rejoins in one commit; keep the wire stream across it.
    queueMicrotask(() => {
      if (joined.listeners.size > 0) {
        return
      }
      if (streams.get(client) === joined) {
        streams.delete(client)
      }
      joined.stopWatching()
      const wire = joined.wire
      joined.wire = null
      wire?.stop?.()
    })
  }
}

function createStream(client: SharedClientEventsClient): SharedStream {
  const stream: SharedStream = {
    listeners: new Set(),
    wire: null,
    stopWatching: () => {}
  }
  stream.stopWatching = client.onStateChange((state) => {
    if (state === 'connected' && stream.listeners.size > 0 && !stream.wire) {
      openWire(client, stream)
    }
  })
  streams.set(client, stream)
  return stream
}

function openWire(client: SharedClientEventsClient, stream: SharedStream): void {
  const wire: Wire = { stop: null, ready: false, readyOn: null }
  stream.wire = wire
  let stop: () => void
  try {
    stop = client.subscribe('runtime.clientEvents.subscribe', null, (payload) =>
      deliver(client, stream, wire, payload)
    )
  } catch {
    // A page bridge throws when it can't open a stream now; try again on the next connection.
    if (stream.wire === wire) {
      stream.wire = null
    }
    return
  }
  if (stream.wire === wire) {
    wire.stop = stop
  } else {
    // The wire refused synchronously and already ended.
    stop()
  }
}

function deliver(
  client: SharedClientEventsClient,
  stream: SharedStream,
  wire: Wire,
  payload: unknown
): void {
  if (stream.wire !== wire || !isEvent(payload)) {
    return
  }
  let reopen = false
  if (payload.type === 'ready') {
    wire.ready = true
    wire.readyOn = connectionKey(client)
  } else if (payload.type === 'end' || payload.type === 'error') {
    // A wire that went live may open again at once; one refused before ready waits for a new connection.
    reopen = wire.ready
    stream.wire = null
    // Releases the transport's record too, so a path switch can't replay the dead subscribe.
    wire.stop?.()
  }
  let failure: { error: unknown } | null = null
  // Snapshot: a listener added mid-dispatch hears its own joined ready, not this event too.
  for (const subscription of Array.from(stream.listeners)) {
    if (!stream.listeners.has(subscription)) {
      continue
    }
    try {
      if (payload.type === 'ready') {
        const replayed = subscription.heardReady
        subscription.heardReady = true
        subscription.listener(replayed ? { ...payload, replayed } : payload)
      } else {
        subscription.listener(payload)
      }
    } catch (error) {
      // One throwing consumer must not starve the rest; rethrow to the transport afterwards.
      failure ??= { error }
    }
  }
  if (reopen) {
    // Out of the transport's callback, and after any listener that left or rejoined on this event.
    queueMicrotask(() => {
      if (streams.get(client) === stream && stream.listeners.size > 0 && !stream.wire) {
        openWire(client, stream)
      }
    })
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
  return hostConnectionEpoch(client)
}
