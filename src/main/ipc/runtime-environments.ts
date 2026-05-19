/* eslint-disable max-lines -- Why: runtime environment IPC is the security boundary for saved server calls and subscriptions; keeping ownership checks, lifecycle cleanup, and binary forwarding together makes the bridge auditable. */
import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed,
  removeEnvironment,
  resolveEnvironment,
  resolveEnvironmentPairingOffer
} from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  getPreferredPairingOffer,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import {
  closeRemoteRuntimeRequestConnection,
  sendRemoteRuntimeConnectionRequest
} from './runtime-environment-request-connections'

const DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS = 15_000
type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  ownerWebContentsId: number
  removeDestroyedListener: () => void
}
const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()

function getUserDataPath(): string {
  return app.getPath('userData')
}

function shouldUseCachedRequestConnection(method: string): boolean {
  return method === 'terminal.send' || method === 'terminal.updateViewport'
}

export function registerRuntimeEnvironmentHandlers(): void {
  ipcMain.handle('runtimeEnvironments:list', (): PublicKnownRuntimeEnvironment[] =>
    listEnvironments(getUserDataPath()).map(redactRuntimeEnvironment)
  )
  ipcMain.handle(
    'runtimeEnvironments:addFromPairingCode',
    (
      _event,
      args: { name: string; pairingCode: string }
    ): { environment: PublicKnownRuntimeEnvironment } => ({
      environment: redactRuntimeEnvironment(addEnvironmentFromPairingCode(getUserDataPath(), args))
    })
  )
  ipcMain.handle(
    'runtimeEnvironments:resolve',
    (_event, args: { selector: string }): PublicKnownRuntimeEnvironment =>
      redactRuntimeEnvironment(resolveEnvironment(getUserDataPath(), args.selector))
  )
  ipcMain.handle(
    'runtimeEnvironments:remove',
    (_event, args: { selector: string }): { removed: PublicKnownRuntimeEnvironment } => {
      const removed = removeEnvironment(getUserDataPath(), args.selector)
      closeRemoteRuntimeRequestConnection(removed.id)
      if (args.selector !== removed.id) {
        closeRemoteRuntimeRequestConnection(args.selector)
      }
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const userDataPath = getUserDataPath()
      const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
        resolveEnvironmentPairingOffer(userDataPath, args.selector),
        'status.get',
        undefined,
        args.timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
      )
      if (response.ok === true) {
        markEnvironmentUsed(userDataPath, args.selector, { runtimeId: response._meta.runtimeId })
      }
      return response
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      _event,
      args: { selector: string; method: string; params?: unknown; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      return callRuntimeEnvironment(args.selector, args.method, args.params, args.timeoutMs)
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:subscribe',
    async (
      event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        subscriptionId?: string
      }
    ): Promise<{ subscriptionId: string; requestId: string }> => {
      const subscriptionId =
        typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
          ? args.subscriptionId
          : randomUUID()
      if (remoteRuntimeSubscriptions.has(subscriptionId)) {
        throw new Error('Runtime environment subscription id already exists')
      }
      const sender = event.sender
      const ownerWebContentsId = sender.id
      let senderDestroyed = sender.isDestroyed()
      let subscription: RemoteRuntimeSubscription | null = null
      let destroyedListenerAttached = false
      const removeDestroyedListener = (): void => {
        if (!destroyedListenerAttached) {
          return
        }
        destroyedListenerAttached = false
        sender.removeListener('destroyed', closeSubscription)
      }
      const closeSubscription = (): void => {
        senderDestroyed = true
        const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
        remoteRuntimeSubscriptions.delete(subscriptionId)
        if (retained) {
          retained.close()
          return
        }
        removeDestroyedListener()
        subscription?.close()
      }
      sender.once('destroyed', closeSubscription)
      destroyedListenerAttached = true
      try {
        subscription = await subscribeRuntimeEnvironment(
          args.selector,
          args.method,
          args.params,
          args.timeoutMs,
          {
            onEvent: (payload) => {
              if (!sender.isDestroyed()) {
                sender.send('runtimeEnvironments:subscriptionEvent', {
                  subscriptionId,
                  ...payload
                })
              }
            },
            onClose: () => {
              const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
              retained?.removeDestroyedListener()
              remoteRuntimeSubscriptions.delete(subscriptionId)
            }
          }
        )
      } catch (error) {
        removeDestroyedListener()
        throw error
      }
      if (senderDestroyed || sender.isDestroyed()) {
        removeDestroyedListener()
        subscription.close()
        return { subscriptionId, requestId: subscription.requestId }
      }
      remoteRuntimeSubscriptions.set(subscriptionId, {
        requestId: subscription.requestId,
        ownerWebContentsId,
        removeDestroyedListener,
        sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
        close: () => {
          removeDestroyedListener()
          subscription?.close()
        }
      })
      return { subscriptionId, requestId: subscription.requestId }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:unsubscribe',
    (event, args: { subscriptionId: string }): { unsubscribed: boolean } => {
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (!subscription || subscription.ownerWebContentsId !== event.sender.id) {
        return { unsubscribed: false }
      }
      remoteRuntimeSubscriptions.delete(args.subscriptionId)
      subscription.close()
      return { unsubscribed: true }
    }
  )
  ipcMain.on(
    'runtimeEnvironments:subscriptionBinary',
    (event, args: { subscriptionId?: unknown; bytes?: unknown }) => {
      if (typeof args.subscriptionId !== 'string') {
        return
      }
      const bytes = toBinaryPayload(args.bytes)
      if (!bytes) {
        return
      }
      const subscription = remoteRuntimeSubscriptions.get(args.subscriptionId)
      if (subscription?.ownerWebContentsId === event.sender.id) {
        subscription.sendBinary(bytes)
      }
    }
  )
}

function toBinaryPayload(value: unknown): Uint8Array<ArrayBufferLike> | null {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}

async function callRuntimeEnvironment(
  selector: string,
  method: string,
  params: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<unknown>> {
  const userDataPath = getUserDataPath()
  const environment = resolveEnvironment(userDataPath, selector)
  return enqueueRuntimeCall(environment.id, method, async () => {
    const currentEnvironment = resolveEnvironment(userDataPath, environment.id)
    const pairing = getPreferredPairingOffer(currentEnvironment)
    const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
    // Why: the cached request socket is only needed for terminal hot paths.
    // Startup/control-plane RPCs use the proven one-shot path so repo hydration
    // cannot be coupled to a stale terminal-control connection.
    const response = shouldUseCachedRequestConnection(method)
      ? await sendRemoteRuntimeConnectionRequest(
          currentEnvironment.id,
          pairing,
          method,
          params,
          effectiveTimeoutMs
        )
      : await sendRemoteRuntimeRequest(pairing, method, params, effectiveTimeoutMs)
    if (response.ok === true) {
      markEnvironmentUsed(userDataPath, currentEnvironment.id, {
        runtimeId: response._meta.runtimeId
      })
    }
    return response
  })
}

async function subscribeRuntimeEnvironment(
  selector: string,
  method: string,
  params: unknown,
  timeoutMs: number | undefined,
  callbacks: {
    onEvent: (
      payload:
        | { type: 'response'; response: RuntimeRpcResponse<unknown> }
        | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
        | { type: 'error'; code: string; message: string }
        | { type: 'close' }
    ) => void
    onClose: () => void
  }
): Promise<RemoteRuntimeSubscription> {
  const userDataPath = getUserDataPath()
  let markedUsed = false
  const markUsedOnce = (runtimeId: string): void => {
    if (markedUsed) {
      return
    }
    markedUsed = true
    markEnvironmentUsed(userDataPath, selector, { runtimeId })
  }
  const subscription = await subscribeRemoteRuntimeRequest(
    resolveEnvironmentPairingOffer(userDataPath, selector),
    method,
    params,
    timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS,
    {
      onResponse: (response) => {
        if (response.ok === true) {
          markUsedOnce(response._meta.runtimeId)
        }
        callbacks.onEvent({ type: 'response', response })
      },
      onBinary: (bytes) => callbacks.onEvent({ type: 'binary', bytes }),
      onError: (error) =>
        callbacks.onEvent({ type: 'error', code: error.code, message: error.message }),
      onClose: () => {
        callbacks.onEvent({ type: 'close' })
        callbacks.onClose()
      }
    }
  )
  return subscription
}
