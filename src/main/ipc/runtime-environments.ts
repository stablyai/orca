import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import type { Store } from '../persistence'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  registerRuntimeEnvironmentConnectivityHandlers,
  registerRuntimeEnvironmentPassiveHandlers
} from './runtime-environment-connectivity-handlers'
import { closeRemoteRuntimeRequestConnection } from './runtime-environment-request-connections'
import { registerRuntimeEnvironmentRecoveryHandler } from './runtime-environment-recovery-handler'
import {
  advanceRuntimeEnvironmentTransportGeneration,
  getRuntimeEnvironmentTransportGeneration
} from './runtime-environment-transport-generation'
import {
  clearSharedControlSupport,
  resetSharedControlSupport,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'
import {
  beginRuntimeEnvironmentSubscriptionSetup,
  cancelAllRuntimeEnvironmentSubscriptionSetups,
  cancelRuntimeEnvironmentSubscriptionSetup,
  cancelRuntimeEnvironmentSubscriptionSetupsForEnvironment,
  createRuntimeSubscriptionSetupAbortError,
  finishRuntimeEnvironmentSubscriptionSetup,
  hasRuntimeEnvironmentSubscriptionSetup,
  isRuntimeEnvironmentSubscriptionSetupCurrent
} from './runtime-environment-subscription-setup'

type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  environmentId: string
  ownerWebContentsId: number
  removeDestroyedListener: () => void
  notifyClosed: () => void
}
const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()
const getUserDataPath = (): string => app.getPath('userData')

function closeSubscriptionsForEnvironment(environmentId: string): void {
  cancelRuntimeEnvironmentSubscriptionSetupsForEnvironment(environmentId)
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    remoteRuntimeSubscriptions.delete(subscriptionId)
    // Why: one failing teardown must not strand this environment's other sockets.
    try {
      subscription.close()
    } catch (error) {
      console.warn('[runtime-environments] subscription close failed during retirement:', error)
    }
    try {
      // Why: a shared-control logical close never calls back, so notify directly.
      subscription.notifyClosed()
    } catch (error) {
      console.warn('[runtime-environments] subscription close notice failed:', error)
    }
  }
}
export function invalidateRuntimeEnvironmentTransport(environmentId: string): void {
  // Why: a same-id re-pair must retire every transport that still authenticates as the old peer.
  advanceRuntimeEnvironmentTransportGeneration(environmentId)
  closeRemoteRuntimeRequestConnection(environmentId)
  clearSharedControlSupport(environmentId)
  closeSubscriptionsForEnvironment(environmentId)
}

export function registerRuntimeEnvironmentHandlers(store: Store): void {
  // Why: direct re-registration must not stack the binary send listener.
  resetSharedControlSupport()
  cancelAllRuntimeEnvironmentSubscriptionSetups()
  for (const channel of RUNTIME_ENVIRONMENT_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeAllListeners('runtimeEnvironments:subscriptionBinary')

  registerRuntimeEnvironmentConnectivityHandlers({
    store,
    getUserDataPath,
    invalidateTransport: invalidateRuntimeEnvironmentTransport
  })
  registerRuntimeEnvironmentRecoveryHandler()
  registerRuntimeEnvironmentPassiveHandlers(getUserDataPath)
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
      if (
        remoteRuntimeSubscriptions.has(subscriptionId) ||
        hasRuntimeEnvironmentSubscriptionSetup(subscriptionId)
      ) {
        throw new Error('Runtime environment subscription id already exists')
      }
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        throw new Error('runtime_manually_disconnected')
      }
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
      const setupController = beginRuntimeEnvironmentSubscriptionSetup({
        subscriptionId,
        environmentId: environment.id,
        ownerWebContentsId
      })
      let senderDestroyed = sender.isDestroyed()
      let subscription: RemoteRuntimeSubscription | null = null
      let retainedSubscription: RetainedRemoteRuntimeSubscription | null = null
      let subscriptionClosed = false
      let destroyedListenerAttached = false
      const ownsSubscriptionId = (): boolean =>
        isRuntimeEnvironmentSubscriptionSetupCurrent(subscriptionId, setupController) ||
        remoteRuntimeSubscriptions.get(subscriptionId) === retainedSubscription
      const removeDestroyedListener = (): void => {
        if (!destroyedListenerAttached) {
          return
        }
        destroyedListenerAttached = false
        sender.removeListener('destroyed', closeSubscription)
      }
      const closeSubscription = (): void => {
        senderDestroyed = true
        cancelRuntimeEnvironmentSubscriptionSetup(subscriptionId, ownerWebContentsId)
        const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
        if (retained && retained === retainedSubscription) {
          remoteRuntimeSubscriptions.delete(subscriptionId)
          retained.close()
          return
        }
        removeDestroyedListener()
        subscription?.close()
      }
      // Why: a re-entrant or dying renderer must not duplicate or interrupt close notices.
      let closeNotified = false
      const notifyClosed = (): void => {
        if (closeNotified || sender.isDestroyed()) {
          return
        }
        closeNotified = true
        try {
          sender.send('runtimeEnvironments:subscriptionEvent', { subscriptionId, type: 'close' })
        } catch {
          // The renderer is gone; there is no one left to tell.
        }
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
              if (!ownsSubscriptionId() || sender.isDestroyed()) {
                return
              }
              if (payload.type === 'close') {
                notifyClosed()
                return
              }
              if (transportIsCurrent()) {
                sender.send('runtimeEnvironments:subscriptionEvent', {
                  subscriptionId,
                  ...payload
                })
              }
            },
            onClose: () => {
              subscriptionClosed = true
              removeDestroyedListener()
              if (remoteRuntimeSubscriptions.get(subscriptionId) === retainedSubscription) {
                remoteRuntimeSubscriptions.delete(subscriptionId)
              }
            }
          },
          setupController.signal
        )
      } catch (error) {
        removeDestroyedListener()
        throw error
      } finally {
        finishRuntimeEnvironmentSubscriptionSetup(subscriptionId, setupController)
      }
      if (setupController.signal.aborted) {
        removeDestroyedListener()
        subscription.close()
        throw createRuntimeSubscriptionSetupAbortError()
      }
      if (subscriptionClosed) {
        throw new Error('Runtime environment subscription closed during setup')
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
      retainedSubscription = {
        requestId: subscription.requestId,
        environmentId: environment.id,
        ownerWebContentsId,
        removeDestroyedListener,
        notifyClosed,
        sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
        close: () => {
          removeDestroyedListener()
          subscription?.close()
        }
      }
      remoteRuntimeSubscriptions.set(subscriptionId, retainedSubscription)
      return { subscriptionId, requestId: subscription.requestId }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:unsubscribe',
    (event, args: { subscriptionId: string }): { unsubscribed: boolean } => {
      if (cancelRuntimeEnvironmentSubscriptionSetup(args.subscriptionId, event.sender.id)) {
        return { unsubscribed: true }
      }
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
