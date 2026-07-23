import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { RemoteRuntimeSubscription } from '../../shared/remote-runtime-client'
import { isRemoteRuntimeBinaryFrameWithinLimit } from '../../shared/remote-runtime-memory-limits'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { createRuntimeEnvironmentSubscriptionAdmission } from './runtime-environment-subscription-admission'
import {
  retainRuntimeEnvironmentTransportGeneration,
  type RuntimeEnvironmentTransportGenerationLease
} from './runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  environmentId: string
  ownerWebContentsId: number
  removeDestroyedListener: () => void
  releaseOwnership: () => void
}

const remoteRuntimeSubscriptions = new Map<string, RetainedRemoteRuntimeSubscription>()

export function closeAllRuntimeEnvironmentSubscriptions(): void {
  for (const [subscriptionId, subscription] of Array.from(remoteRuntimeSubscriptions)) {
    remoteRuntimeSubscriptions.delete(subscriptionId)
    subscription.close()
  }
}

export function closeRuntimeEnvironmentSubscriptionsForEnvironment(environmentId: string): void {
  for (const [subscriptionId, subscription] of remoteRuntimeSubscriptions) {
    if (subscription.environmentId !== environmentId) {
      continue
    }
    remoteRuntimeSubscriptions.delete(subscriptionId)
    subscription.close()
  }
}

export function registerRuntimeEnvironmentSubscriptionHandlers(
  getUserDataPath: () => string
): void {
  const subscriptionAdmission = createRuntimeEnvironmentSubscriptionAdmission()
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
      const releaseAdmission = subscriptionAdmission.claim(subscriptionId, args.params)
      let transportLease: RuntimeEnvironmentTransportGenerationLease | null = null
      let transportLeaseReleased = false
      let transportWasCurrentAtRelease = true
      const transportSetupIsCurrent = (): boolean =>
        transportLeaseReleased
          ? transportWasCurrentAtRelease
          : (transportLease?.isCurrent() ?? true)
      const transportIsCurrent = (): boolean =>
        !transportLeaseReleased && (transportLease?.isCurrent() ?? true)
      const releaseTransportLease = (): void => {
        if (!transportLease || transportLeaseReleased) {
          return
        }
        transportWasCurrentAtRelease = transportLease.isCurrent()
        transportLeaseReleased = true
        transportLease.release()
      }
      const releaseOwnership = (): void => {
        releaseAdmission()
        releaseTransportLease()
      }
      let ownershipTransferred = false
      try {
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
        transportLease = retainRuntimeEnvironmentTransportGeneration(environment.id)
        const sender = event.sender
        const ownerWebContentsId = sender.id
        let senderDestroyed = sender.isDestroyed()
        let transportClosed = false
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
          releaseOwnership()
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
                transportClosed = true
                const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
                remoteRuntimeSubscriptions.delete(subscriptionId)
                if (retained) {
                  retained.removeDestroyedListener()
                  retained.releaseOwnership()
                  return
                }
                removeDestroyedListener()
                releaseOwnership()
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
        if (!transportSetupIsCurrent() || !pairingIsCurrent) {
          removeDestroyedListener()
          subscription.close()
          throw new Error('Runtime environment pairing changed; refresh and try again')
        }
        if (senderDestroyed || transportClosed || sender.isDestroyed()) {
          removeDestroyedListener()
          subscription.close()
          return { subscriptionId, requestId: subscription.requestId }
        }
        remoteRuntimeSubscriptions.set(subscriptionId, {
          requestId: subscription.requestId,
          environmentId: environment.id,
          ownerWebContentsId,
          removeDestroyedListener,
          releaseOwnership,
          sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
          close: () => {
            removeDestroyedListener()
            releaseOwnership()
            subscription?.close()
          }
        })
        ownershipTransferred = true
        return { subscriptionId, requestId: subscription.requestId }
      } finally {
        if (!ownershipTransferred) {
          releaseOwnership()
        }
      }
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
      if (!bytes || !isRemoteRuntimeBinaryFrameWithinLimit(bytes)) {
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
