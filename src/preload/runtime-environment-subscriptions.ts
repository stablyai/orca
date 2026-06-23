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
  let listenerAttached = false
  const detachListener = (): void => {
    if (!listenerAttached) {
      return
    }
    listenerAttached = false
    ipc.removeListener(SUBSCRIPTION_EVENT_CHANNEL, listener)
  }
  const listener = (_event: unknown, event: RuntimeEnvironmentSubscriptionEvent): void => {
    if (event.subscriptionId !== subscriptionId) {
      return
    }
    if (event.type === 'response') {
      callbacks.onResponse(event.response)
    } else if (event.type === 'binary') {
      callbacks.onBinary?.(event.bytes)
    } else if (event.type === 'error') {
      callbacks.onError?.({ code: event.code, message: event.message })
    } else {
      callbacks.onClose?.()
      // Why: main has already dropped the remote subscription on close, so
      // keeping this per-subscription IPC listener would retain renderer state.
      detachListener()
    }
  }

  // Why: streaming RPCs can emit their first frame before ipcMain.handle()
  // resolves, so preload must subscribe to the event channel before invoking.
  ipc.on(SUBSCRIPTION_EVENT_CHANNEL, listener)
  listenerAttached = true
  try {
    const result = (await ipc.invoke('runtimeEnvironments:subscribe', {
      ...args,
      subscriptionId
    })) as { subscriptionId: string; requestId: string }
    if (result.subscriptionId !== subscriptionId) {
      detachListener()
      throw new Error('Runtime environment subscription id mismatch')
    }
  } catch (error) {
    detachListener()
    throw error
  }

  return {
    unsubscribe: () => {
      detachListener()
      void ipc.invoke('runtimeEnvironments:unsubscribe', { subscriptionId })
    },
    sendBinary: (bytes) => {
      ipc.send('runtimeEnvironments:subscriptionBinary', { subscriptionId, bytes })
    }
  }
}
