import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'

type RuntimeEnvironmentSubscribeArgs = {
  selector: string
  method: string
  params?: unknown
  timeoutMs?: number
}

type RuntimeEnvironmentSubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

export type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

type RuntimeEnvironmentSubscriptionEvent =
  | { subscriptionId: string; type: 'response'; response: RuntimeRpcResponse<unknown> }
  | { subscriptionId: string; type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
  | { subscriptionId: string; type: 'error'; code: string; message: string }
  | { subscriptionId: string; type: 'close' }

type RuntimeEnvironmentSubscriptionIpc = {
  invoke: (channel: string, args: unknown) => Promise<unknown>
  send: (channel: string, args: unknown) => void
  on: (
    channel: string,
    listener: (event: unknown, payload: RuntimeEnvironmentSubscriptionEvent) => void
  ) => void
  removeListener: (
    channel: string,
    listener: (event: unknown, payload: RuntimeEnvironmentSubscriptionEvent) => void
  ) => void
}

const SUBSCRIPTION_EVENT_CHANNEL = 'runtimeEnvironments:subscriptionEvent'

// Why: each subscribe() previously attached its own channel listener that the
// 'error' branch never detached, so reconnecting shared-control subscriptions
// leaked listener closures that pinned renderer state. One active dispatcher per
// ipc instance keeps listener retention O(1) while per-subscription state lives
// only in this map.
type RuntimeEnvironmentSubscriptionDispatcher = {
  callbacks: Map<string, RuntimeEnvironmentSubscriptionCallbacks>
  listener: (event: unknown, payload: RuntimeEnvironmentSubscriptionEvent) => void
}

const subscriptionDispatchers = new WeakMap<
  RuntimeEnvironmentSubscriptionIpc,
  RuntimeEnvironmentSubscriptionDispatcher
>()

function releaseIdleDispatcher(
  ipc: RuntimeEnvironmentSubscriptionIpc,
  callbacks: Map<string, RuntimeEnvironmentSubscriptionCallbacks>,
  listener: RuntimeEnvironmentSubscriptionDispatcher['listener']
): void {
  if (callbacks.size > 0) {
    return
  }
  ipc.removeListener(SUBSCRIPTION_EVENT_CHANNEL, listener)
  subscriptionDispatchers.delete(ipc)
}

function releaseSubscription(
  ipc: RuntimeEnvironmentSubscriptionIpc,
  dispatcher: RuntimeEnvironmentSubscriptionDispatcher,
  subscriptionId: string
): void {
  if (!dispatcher.callbacks.delete(subscriptionId)) {
    return
  }
  releaseIdleDispatcher(ipc, dispatcher.callbacks, dispatcher.listener)
}

function getOrCreateDispatcher(
  ipc: RuntimeEnvironmentSubscriptionIpc
): RuntimeEnvironmentSubscriptionDispatcher {
  const existing = subscriptionDispatchers.get(ipc)
  if (existing) {
    return existing
  }
  const callbacks = new Map<string, RuntimeEnvironmentSubscriptionCallbacks>()
  const listener = (_event: unknown, event: RuntimeEnvironmentSubscriptionEvent): void => {
    const subscriptionCallbacks = callbacks.get(event.subscriptionId)
    if (!subscriptionCallbacks) {
      return
    }
    if (event.type === 'response') {
      subscriptionCallbacks.onResponse(event.response)
    } else if (event.type === 'binary') {
      subscriptionCallbacks.onBinary?.(event.bytes)
    } else if (event.type === 'error') {
      // Why: errors are non-terminal for shared-control subscriptions (they
      // survive reconnects), so the entry stays mapped until the consumer
      // unsubscribes.
      subscriptionCallbacks.onError?.({ code: event.code, message: event.message })
    } else {
      // Why: close is terminal; release before the callback so a throwing or
      // re-entrant onClose cannot keep renderer state mapped.
      callbacks.delete(event.subscriptionId)
      releaseIdleDispatcher(ipc, callbacks, listener)
      subscriptionCallbacks.onClose?.()
    }
  }
  const dispatcher: RuntimeEnvironmentSubscriptionDispatcher = { callbacks, listener }
  subscriptionDispatchers.set(ipc, dispatcher)
  ipc.on(SUBSCRIPTION_EVENT_CHANNEL, listener)
  return dispatcher
}

function createRuntimeEnvironmentSubscriptionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (typeof randomUuid === 'function') {
    return randomUuid.call(globalThis.crypto)
  }
  return `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function subscribeRuntimeEnvironmentFromPreload(
  ipc: RuntimeEnvironmentSubscriptionIpc,
  args: RuntimeEnvironmentSubscribeArgs,
  callbacks: RuntimeEnvironmentSubscriptionCallbacks,
  createSubscriptionId = createRuntimeEnvironmentSubscriptionId
): Promise<RuntimeEnvironmentSubscriptionHandle> {
  const subscriptionId = createSubscriptionId()
  // Why: streaming RPCs can emit their first frame before ipcMain.handle()
  // resolves, so the dispatcher must be routing this id before invoking.
  const dispatcher = getOrCreateDispatcher(ipc)
  dispatcher.callbacks.set(subscriptionId, callbacks)
  const releaseCurrentSubscription = (): void => {
    releaseSubscription(ipc, dispatcher, subscriptionId)
  }
  try {
    const result = (await ipc.invoke('runtimeEnvironments:subscribe', {
      ...args,
      subscriptionId
    })) as { subscriptionId: string; requestId: string }
    if (result.subscriptionId !== subscriptionId) {
      releaseCurrentSubscription()
      throw new Error('Runtime environment subscription id mismatch')
    }
  } catch (error) {
    releaseCurrentSubscription()
    throw error
  }

  return {
    unsubscribe: () => {
      releaseCurrentSubscription()
      void ipc.invoke('runtimeEnvironments:unsubscribe', { subscriptionId })
    },
    sendBinary: (bytes) => {
      ipc.send('runtimeEnvironments:subscriptionBinary', { subscriptionId, bytes })
    }
  }
}
