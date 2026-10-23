import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { abortWhenRendererGone } from '../renderer-lifetime-abort'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-connectivity-handlers'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

export type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  setupController: AbortController
  environmentId: string
  ownerWebContentsId: number
  disposeRendererLifetime: () => void
  notifyClosed: () => void
}
export type PendingRuntimeSubscription = {
  ownerWebContentsId: number
  environmentId: string
  close: () => void
}

export function registerRuntimeEnvironmentSubscriptionHandlers(args: {
  getUserDataPath: () => string
  remoteRuntimeSubscriptions: Map<string, RetainedRemoteRuntimeSubscription>
  pendingSubscriptions: Map<string, PendingRuntimeSubscription>
  recordLayoutFrame: (
    environmentId: string,
    method: string,
    response: RuntimeRpcResponse<unknown>
  ) => void
}): void {
  const { getUserDataPath, remoteRuntimeSubscriptions, pendingSubscriptions, recordLayoutFrame } =
    args
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
        expectedEnvironmentRuntimeId?: string
      }
    ): Promise<{ subscriptionId: string; requestId: string }> => {
      const subscriptionId =
        typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
          ? args.subscriptionId
          : randomUUID()
      if (
        remoteRuntimeSubscriptions.has(subscriptionId) ||
        pendingSubscriptions.has(subscriptionId)
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
      if (
        args.expectedEnvironmentRuntimeId !== undefined &&
        environment.runtimeId !== args.expectedEnvironmentRuntimeId
      ) {
        throw new Error('Runtime environment identity changed; refresh and try again')
      }
      const transportGeneration = getRuntimeEnvironmentTransportGeneration(environment.id)
      const transportIsCurrent = (): boolean =>
        getRuntimeEnvironmentTransportGeneration(environment.id) === transportGeneration
      const sender = event.sender
      const ownerWebContentsId = sender.id
      const setupController = new AbortController()
      let rendererGone = sender.isDestroyed()
      let subscription: RemoteRuntimeSubscription | null = null
      const rendererLifetime = abortWhenRendererGone(sender)
      const disposeRendererLifetime = (): void => {
        rendererLifetime.dispose()
        rendererLifetime.signal.removeEventListener('abort', closeSubscription)
      }
      const closeSubscription = (): void => {
        rendererGone = true
        setupController.abort()
        if (pendingSubscriptions.get(subscriptionId) === pending) {
          pendingSubscriptions.delete(subscriptionId)
        }
        const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
        if (retained?.setupController === setupController) {
          remoteRuntimeSubscriptions.delete(subscriptionId)
          retained.close()
          return
        }
        disposeRendererLifetime()
        subscription?.close()
      }
      // Why: the renderer treats close as terminal and drops its handle, so send it once.
      // Latch before sending so a re-entrant call cannot duplicate it, and never
      // throw: a dying renderer must not abort its siblings' retirement.
      let closeNotified = false
      let transportClosed = false
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
      const pending = {
        ownerWebContentsId,
        environmentId: environment.id,
        close: closeSubscription
      }
      pendingSubscriptions.set(subscriptionId, pending)
      // A reload replaces the owning document without destroying its WebContents.
      rendererLifetime.signal.addEventListener('abort', closeSubscription, { once: true })
      try {
        subscription = await subscribeRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          {
            onEvent: (payload) => {
              if (
                rendererGone ||
                (pendingSubscriptions.get(subscriptionId) !== pending &&
                  remoteRuntimeSubscriptions.get(subscriptionId)?.setupController !==
                    setupController)
              ) {
                return
              }
              if (payload.type === 'close') {
                // Why: retirement advances the generation before closing, so gating
                // close on it stranded the renderer with a dead subscription.
                notifyClosed()
                return
              }
              if (transportIsCurrent() && !sender.isDestroyed()) {
                sender.send('runtimeEnvironments:subscriptionEvent', {
                  subscriptionId,
                  ...payload
                })
                // After the send, so recording never delays or changes what the window gets.
                if (payload.type === 'response') {
                  recordLayoutFrame(environment.id, args.method, payload.response)
                }
              }
            },
            onClose: () => {
              transportClosed = true
              if (rendererGone) {
                return
              }
              const retained = remoteRuntimeSubscriptions.get(subscriptionId) ?? null
              if (retained?.setupController === setupController) {
                retained.disposeRendererLifetime()
                remoteRuntimeSubscriptions.delete(subscriptionId)
              }
            }
          },
          () => transportIsCurrent() && !setupController.signal.aborted,
          setupController.signal
        )
      } catch (error) {
        if (pendingSubscriptions.get(subscriptionId) === pending) {
          pendingSubscriptions.delete(subscriptionId)
        }
        disposeRendererLifetime()
        throw error
      }
      if (pendingSubscriptions.get(subscriptionId) === pending) {
        pendingSubscriptions.delete(subscriptionId)
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
        disposeRendererLifetime()
        subscription.close()
        throw new Error('Runtime environment pairing changed; refresh and try again')
      }
      if (rendererGone || sender.isDestroyed() || transportClosed) {
        disposeRendererLifetime()
        subscription.close()
        return { subscriptionId, requestId: subscription.requestId }
      }
      remoteRuntimeSubscriptions.set(subscriptionId, {
        setupController,
        requestId: subscription.requestId,
        environmentId: environment.id,
        ownerWebContentsId,
        disposeRendererLifetime,
        notifyClosed,
        sendBinary: (bytes) => subscription?.sendBinary(bytes) ?? false,
        close: () => {
          disposeRendererLifetime()
          subscription?.close()
        }
      })
      return { subscriptionId, requestId: subscription.requestId }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:unsubscribe',
    (event, args: { subscriptionId: string }): { unsubscribed: boolean } => {
      const pending = pendingSubscriptions.get(args.subscriptionId)
      if (pending?.ownerWebContentsId === event.sender.id) {
        pending.close()
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
