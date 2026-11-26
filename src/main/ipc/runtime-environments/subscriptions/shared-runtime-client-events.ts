import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'

type UpstreamCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onClose: () => void
}

type PassiveObserver = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onClose: () => void
  closed: boolean
}

type DocumentHostStream = {
  readyResponse: RuntimeRpcResponse<unknown> | null
}

type RelayOwnedUpstream = {
  subscription: RemoteRuntimeTransportSubscription | null
  abortController: AbortController
  closed: boolean
  readyResponse: RuntimeRpcResponse<unknown> | null
}

type SharedChannel = {
  key: string
  hostStreams: Set<DocumentHostStream>
  observers: Set<PassiveObserver>
  relayUpstream: RelayOwnedUpstream | null
  openRelayUpstream:
    | ((
        callbacks: UpstreamCallbacks,
        signal: AbortSignal
      ) => Promise<RemoteRuntimeTransportSubscription>)
    | null
}

const channels = new Map<string, SharedChannel>()

function channelKey(environmentId: string, transportGeneration: number): string {
  return `${environmentId}\0${transportGeneration}`
}

function getOrCreateChannel(key: string): SharedChannel {
  let channel = channels.get(key)
  if (!channel) {
    channel = {
      key,
      hostStreams: new Set(),
      observers: new Set(),
      relayUpstream: null,
      openRelayUpstream: null
    }
    channels.set(key, channel)
  }
  return channel
}

function pruneChannel(channel: SharedChannel): void {
  if (
    channel.hostStreams.size === 0 &&
    channel.observers.size === 0 &&
    channel.relayUpstream === null
  ) {
    channels.delete(channel.key)
  }
}

function closeRelayUpstream(channel: SharedChannel): void {
  const upstream = channel.relayUpstream
  if (!upstream) {
    return
  }
  channel.relayUpstream = null
  upstream.closed = true
  upstream.abortController.abort()
  upstream.subscription?.close()
  pruneChannel(channel)
}

function notifyObserversResponse(
  channel: SharedChannel,
  response: RuntimeRpcResponse<unknown>
): void {
  for (const observer of Array.from(channel.observers)) {
    if (!observer.closed) {
      observer.onResponse(response)
    }
  }
}

function notifyObserversClosed(channel: SharedChannel): void {
  const observers = Array.from(channel.observers)
  channel.observers.clear()
  for (const observer of observers) {
    if (!observer.closed) {
      observer.closed = true
      observer.onClose()
    }
  }
  pruneChannel(channel)
}

function isReadyResponse(response: RuntimeRpcResponse<unknown>): boolean {
  return (
    response.ok &&
    typeof response.result === 'object' &&
    response.result !== null &&
    'type' in response.result &&
    response.result.type === 'ready'
  )
}

function readyResponseFor(channel: SharedChannel): RuntimeRpcResponse<unknown> | null {
  if (channel.relayUpstream?.readyResponse) {
    return channel.relayUpstream.readyResponse
  }
  for (const host of channel.hostStreams) {
    if (host.readyResponse) {
      return host.readyResponse
    }
  }
  return null
}

function startRelayUpstream(channel: SharedChannel): void {
  if (channel.relayUpstream || channel.hostStreams.size > 0 || channel.observers.size === 0) {
    return
  }
  const open = channel.openRelayUpstream
  if (!open) {
    notifyObserversClosed(channel)
    return
  }
  const abortController = new AbortController()
  const upstream: RelayOwnedUpstream = {
    subscription: null,
    abortController,
    closed: false,
    readyResponse: null
  }
  channel.relayUpstream = upstream
  const handleClose = (): void => {
    if (upstream.closed) {
      return
    }
    upstream.closed = true
    if (channel.relayUpstream === upstream) {
      channel.relayUpstream = null
    }
    // Only close passive observers if no desktop document host stream took over.
    if (channel.hostStreams.size === 0) {
      notifyObserversClosed(channel)
    } else {
      pruneChannel(channel)
    }
  }
  void open(
    {
      onResponse: (response) => {
        if (upstream.closed || channel.relayUpstream !== upstream) {
          return
        }
        if (isReadyResponse(response)) {
          upstream.readyResponse = response
        }
        notifyObserversResponse(channel, response)
      },
      onClose: handleClose
    },
    abortController.signal
  ).then((subscription) => {
    if (upstream.closed || channel.relayUpstream !== upstream) {
      subscription.close()
      return
    }
    upstream.subscription = subscription
  }, handleClose)
}

/**
 * Registers a desktop document's `runtime.clientEvents.subscribe` stream so passive main-process
 * observers share it instead of opening a duplicate remote subscription.
 */
export function registerDocumentClientEventsStream(
  environmentId: string,
  transportGeneration: number
): {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onTransportClose: () => void
  unregister: () => void
} {
  const key = channelKey(environmentId, transportGeneration)
  const channel = getOrCreateChannel(key)
  const host: DocumentHostStream = { readyResponse: null }
  channel.hostStreams.add(host)
  let active = true

  return {
    onResponse: (response) => {
      if (!active) {
        return
      }
      if (isReadyResponse(response)) {
        host.readyResponse = response
        // Close any relay-owned stream only once the document stream is ready, avoiding an event gap.
        if (channel.relayUpstream) {
          closeRelayUpstream(channel)
        }
      }
      // Forward only while no relay-owned stream is still feeding observers, to avoid double delivery.
      if (!channel.relayUpstream && channel.observers.size > 0) {
        notifyObserversResponse(channel, response)
      }
    },
    onTransportClose: () => {
      if (!active) {
        return
      }
      active = false
      channel.hostStreams.delete(host)
      if (channel.hostStreams.size === 0 && !channel.relayUpstream) {
        notifyObserversClosed(channel)
      } else {
        pruneChannel(channel)
      }
    },
    unregister: () => {
      if (!active) {
        return
      }
      active = false
      channel.hostStreams.delete(host)
      // Document closed while the transport is still alive: promote to a relay-owned stream if needed.
      if (channel.hostStreams.size === 0 && channel.observers.size > 0 && !channel.relayUpstream) {
        startRelayUpstream(channel)
      } else {
        pruneChannel(channel)
      }
    }
  }
}

/**
 * Subscribes a main-process observer to `runtime.clientEvents.subscribe`, reusing an active
 * desktop document stream or shared relay stream for the same `(environmentId, transportGeneration)`.
 */
export function subscribeSharedRuntimeClientEvents(args: {
  environmentId: string
  transportGeneration: number
  openUpstream: (
    callbacks: UpstreamCallbacks,
    signal: AbortSignal
  ) => Promise<RemoteRuntimeTransportSubscription>
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onClose: () => void
}): { close: () => void } {
  const key = channelKey(args.environmentId, args.transportGeneration)
  const channel = getOrCreateChannel(key)
  channel.openRelayUpstream = args.openUpstream
  const cachedReady = readyResponseFor(channel)
  const observer: PassiveObserver = {
    onResponse: args.onResponse,
    onClose: args.onClose,
    closed: false
  }
  channel.observers.add(observer)

  if (channel.hostStreams.size === 0 && !channel.relayUpstream) {
    startRelayUpstream(channel)
  } else if (cachedReady) {
    queueMicrotask(() => {
      if (!observer.closed) {
        observer.onResponse(cachedReady)
      }
    })
  }

  return {
    close: () => {
      if (observer.closed) {
        return
      }
      observer.closed = true
      channel.observers.delete(observer)
      if (channel.observers.size === 0) {
        closeRelayUpstream(channel)
      } else {
        pruneChannel(channel)
      }
    }
  }
}
