import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import type { Store } from '../persistence'
import { clearActiveRuntimeEnvironmentFocusIfMatches } from '../runtime-environment-focus-self-heal'
import { closeRemoteRuntimeRequestConnection } from './runtime-environment-request-connections'
import {
  advanceRuntimeEnvironmentTransportGeneration,
  getRuntimeEnvironmentTransportGeneration
} from './runtime-environment-transport-generation'
import {
  callRuntimeEnvironment,
  clearSharedControlSupport,
  getRuntimeEnvironmentStatus,
  resetSharedControlSupport,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'

const RUNTIME_ENVIRONMENT_HANDLER_CHANNELS = [
  'runtimeEnvironments:list',
  'runtimeEnvironments:addFromPairingCode',
  'runtimeEnvironments:resolve',
  'runtimeEnvironments:remove',
  'runtimeEnvironments:disconnect',
  'runtimeEnvironments:getStatus',
  'runtimeEnvironments:call',
  'runtimeEnvironments:subscribe',
  'runtimeEnvironments:unsubscribe'
] as const

type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  environmentId: string
  ownerWebContentsId: number
  removeDestroyedListener: () => void
}
const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
const getUserDataPath = (): string => app.getPath('userData')

function closeSubscriptionsForEnvironment(environmentId: string): void {
  // Why: removed runtimes must not retain terminal/browser WebSockets until renderer teardown.
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    remoteRuntimeSubscriptions.delete(subscriptionId)
    subscription.close()
  }
}
export function invalidateRuntimeEnvironmentTransport(environmentId: string): void {
  // Why: a same-id re-pair must retire every transport that still authenticates as the old peer.
  advanceRuntimeEnvironmentTransportGeneration(environmentId)
  closeRemoteRuntimeRequestConnection(environmentId)
  clearSharedControlSupport(environmentId)
  closeSubscriptionsForEnvironment(environmentId)
}

function listPublicRuntimeEnvironments(): PublicKnownRuntimeEnvironment[] {
  // Why: a corrupt VM store must not break persisted environment listing.
  return listEnvironments(getUserDataPath()).map(redactRuntimeEnvironment)
}

export function registerRuntimeEnvironmentHandlers(store: Store): void {
  // Why: keep direct re-registration safe even though register-core-handlers
  // normally guards this path; otherwise the binary send listener can stack.
  resetSharedControlSupport()
  for (const channel of RUNTIME_ENVIRONMENT_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('runtimeEnvironments:subscriptionBinary')

  ipcMain.handle('runtimeEnvironments:list', (): PublicKnownRuntimeEnvironment[] =>
    listPublicRuntimeEnvironments()
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
      invalidateRuntimeEnvironmentTransport(removed.id)
      if (args.selector !== removed.id) {
        closeRemoteRuntimeRequestConnection(args.selector)
        clearSharedControlSupport(args.selector)
      }
      clearActiveRuntimeEnvironmentFocusIfMatches(store, removed.id)
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    (_event, args: { selector: string }): { disconnected: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      // Why: disconnect is intentionally non-destructive; it drops live
      // transport state while keeping the paired server available for later.
      invalidateRuntimeEnvironmentTransport(environment.id)
      if (args.selector !== environment.id) {
        closeRemoteRuntimeRequestConnection(args.selector)
        clearSharedControlSupport(args.selector)
      }
      return { disconnected: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      return getRuntimeEnvironmentStatus(getUserDataPath(), args.selector, args.timeoutMs)
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      _event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      return callRuntimeEnvironment(
        getUserDataPath(),
        args.selector,
        args.method,
        args.params,
        args.timeoutMs,
        args.expectedEnvironmentPairingRevision
      )
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
        expectedEnvironmentPairingRevision?: number
      }
    ): Promise<{ subscriptionId: string; requestId: string }> => {
      const subscriptionId =
        typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
          ? args.subscriptionId
          : randomUUID()
      if (remoteRuntimeSubscriptions.has(subscriptionId)) {
        throw new Error('Runtime environment subscription id already exists')
      }
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      const pairingRevision = environment.pairingRevision ?? environment.createdAt
      if (
        args.expectedEnvironmentPairingRevision !== undefined &&
        pairingRevision !== args.expectedEnvironmentPairingRevision
      ) {
        throw new Error('Runtime environment pairing changed; refresh and try again')
      }
      const transportGeneration = getRuntimeEnvironmentTransportGeneration(environment.id)
      const transportIsCurrent = (): boolean =>
        getRuntimeEnvironmentTransportGeneration(environment.id) === transportGeneration
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
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          {
            onEvent: (payload) => {
              if (transportIsCurrent() && !sender.isDestroyed()) {
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
      let pairingIsCurrent = false
      try {
        const currentEnvironment = resolveEnvironment(getUserDataPath(), environment.id)
        pairingIsCurrent =
          (currentEnvironment.pairingRevision ?? currentEnvironment.createdAt) === pairingRevision
      } catch {
        pairingIsCurrent = false
      }
      if (!transportIsCurrent() || !pairingIsCurrent) {
        removeDestroyedListener()
        subscription.close()
        throw new Error('Runtime environment pairing changed; refresh and try again')
      }
      if (senderDestroyed || sender.isDestroyed()) {
        removeDestroyedListener()
        subscription.close()
        return { subscriptionId, requestId: subscription.requestId }
      }
      remoteRuntimeSubscriptions.set(subscriptionId, {
        requestId: subscription.requestId,
        environmentId: environment.id,
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
