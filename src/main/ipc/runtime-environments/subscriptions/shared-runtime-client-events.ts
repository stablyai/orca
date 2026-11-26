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
  sawReady: boolean
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
  // The one document stream that feeds observers, so two windows never deliver each event twice.
  feeder: DocumentHostStream | null
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
      feeder: null,
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

function deliverResponse(observer: PassiveObserver, response: RuntimeRpcResponse<unknown>): void {
  if (isReadyResponse(response)) {
    observer.sawReady = true
  }
  try {
    observer.onResponse(response)
  } catch (error) {
    // One observer's failure must not starve the others sharing this stream.
    console.warn('[runtime-environments] shared client-event observer failed', error)
  }
}

function notifyObserversResponse(
  channel: SharedChannel,
  response: RuntimeRpcResponse<unknown>
): void {
  for (const observer of Array.from(channel.observers)) {
    if (!observer.closed) {
      deliverResponse(observer, response)
    }
  }
}

function notifyObserversClosed(channel: SharedChannel): void {
  const observers = Array.from(channel.observers)
  channel.observers.clear()
  for (const observer of observers) {
    if (!observer.closed) {
      observer.closed = true
      try {
        observer.onClose()
      } catch (error) {
        console.warn('[runtime-environments] shared client-event observer close failed', error)
      }
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
  return channel.relayUpstream?.readyResponse ?? channel.feeder?.readyResponse ?? null
}

function startRelayUpstream(channel: SharedChannel): void {
  if (channel.relayUpstream || channel.feeder || channel.observers.size === 0) {
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
    // Only close passive observers if no desktop document stream took over.
    if (!channel.feeder) {
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
  const detach = (): void => {
    if (!active) {
      return
    }
    active = false
    channel.hostStreams.delete(host)
    if (channel.feeder === host) {
      channel.feeder = null
      for (const candidate of channel.hostStreams) {
        if (candidate.readyResponse) {
          channel.feeder = candidate
          break
        }
      }
    }
    if (!channel.feeder && channel.observers.size > 0) {
      // Why: a document socket close does not say whether the host is gone. Reopening our own
      // stream keeps observers fed when it isn't, and fails (closing them) when the transport is.
      startRelayUpstream(channel)
    } else {
      pruneChannel(channel)
    }
  }

  return {
    onResponse: (response) => {
      if (!active) {
        return
      }
      const ready = isReadyResponse(response)
      if (ready) {
        host.readyResponse = response
      }
      if (!channel.feeder) {
        if (!channel.relayUpstream) {
          channel.feeder = host
        } else if (ready) {
          // Close the relay-owned stream only once the document stream is ready, avoiding an event gap.
          channel.feeder = host
          closeRelayUpstream(channel)
        }
      }
      if (channel.feeder === host && channel.observers.size > 0) {
        notifyObserversResponse(channel, response)
      }
    },
    onTransportClose: detach,
    unregister: detach
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
    closed: false,
    sawReady: false
  }
  channel.observers.add(observer)

  if (channel.hostStreams.size === 0 && !channel.relayUpstream) {
    startRelayUpstream(channel)
  } else if (cachedReady) {
    queueMicrotask(() => {
      // A live ready that arrived first already initialized this observer.
      if (!observer.closed && !observer.sawReady) {
        deliverResponse(observer, cachedReady)
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
