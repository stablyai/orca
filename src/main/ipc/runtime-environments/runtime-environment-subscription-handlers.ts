import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { abortWhenRendererGone } from '../renderer-lifetime-abort'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'
import type {
  RuntimeRpcDispatchObservation,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-connectivity-handlers'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import { registerRuntimeEnvironmentSubscriptionControls } from './runtime-environment-subscription-controls'

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
  createAssociationObserver?: (
    environmentId: string,
    identity: string
  ) => { observe: (frame: unknown) => void; dispose: () => void }
  recordLayoutFrame: (
    environmentId: string,
    method: string,
    response: RuntimeRpcResponse<unknown>
  ) => void
}): void {
  const {
    getUserDataPath,
    remoteRuntimeSubscriptions,
    pendingSubscriptions,
    recordLayoutFrame,
    createAssociationObserver
  } = args
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
        observeDispatch?: boolean
        dispatchObservation?: RuntimeRpcDispatchObservation
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
      const dispatchBy =
        args.dispatchObservation?.expiresAt ?? Date.now() + (args.timeoutMs ?? 30_000)
      let dispatchTimer: ReturnType<typeof setTimeout> | undefined
      let sentAt: number | undefined
      const associationObserver =
        args.method === 'agentSession.subscribeStatus'
          ? createAssociationObserver?.(
              environment.id,
              JSON.stringify([
                environment.runtimeId,
                environment.pairingRevision ?? environment.createdAt
              ])
            )
          : undefined
      let rendererGone = sender.isDestroyed()
      let subscription: RemoteRuntimeSubscription | null = null
      const rendererLifetime = abortWhenRendererGone(sender)
      const disposeRendererLifetime = (): void => {
        clearTimeout(dispatchTimer)
        associationObserver?.dispose()
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
      // Notify close once, latched before send; a dying renderer must not interrupt sibling retirement.
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
      if (args.dispatchObservation) {
        dispatchTimer = setTimeout(
          () => {
            notifyClosed()
            closeSubscription()
          },
          Math.max(0, dispatchBy - Date.now())
        )
      }
      try {
        subscription = await subscribeRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          {
            beforeSend:
              args.observeDispatch || args.dispatchObservation
                ? () => {
                    if (
                      !transportIsCurrent() ||
                      setupController.signal.aborted ||
                      Date.now() >= dispatchBy
                    ) {
                      throw new Error('request expired')
                    }
                    sentAt ??= Date.now()
                    if (args.dispatchObservation) {
                      clearTimeout(dispatchTimer)
                      dispatchTimer = setTimeout(
                        () => {
                          notifyClosed()
                          closeSubscription()
                        },
                        Math.max(
                          0,
                          (args.dispatchObservation.responseExpiresAt ??
                            sentAt + args.dispatchObservation.responseTimeoutMs) - Date.now()
                        )
                      )
                    }
                    if (!sender.isDestroyed()) {
                      sender.send('runtimeEnvironments:subscriptionEvent', {
                        subscriptionId,
                        type: 'sent',
                        sentAt
                      })
                    }
                  }
                : undefined,
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
                // Retirement advances generation before close; the old generation still needs its terminal notification.
                notifyClosed()
                return
              }
              if (transportIsCurrent() && !sender.isDestroyed()) {
                sender.send('runtimeEnvironments:subscriptionEvent', {
                  subscriptionId,
                  ...payload,
                  ...(args.observeDispatch && sentAt !== undefined ? { sentAt } : {})
                })
                if (payload.type === 'response' && payload.response.ok) {
                  try {
                    associationObserver?.observe(payload.response.result)
                  } catch (error) {
                    console.warn('[ai-vault] association observation failed', error)
                  }
                }
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
  registerRuntimeEnvironmentSubscriptionControls(remoteRuntimeSubscriptions, pendingSubscriptions)
}
