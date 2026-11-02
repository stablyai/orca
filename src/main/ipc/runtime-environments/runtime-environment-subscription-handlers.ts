import {
  assertCrewSubscriptionInputs,
  runtimeEnvironmentSubscriptionId,
  assertSettledCrewSubscriptionCurrent,
  assertCrewSubscriptionCurrent,
  resolveSubscriptionEnvironment,
  crewSubscriptionSetupFailure,
  type RuntimeEnvironmentSubscribeArgs,
  type CrewSubscriptionSetupResult,
  type RuntimeEnvironmentSetupFailure,
  type RuntimeEnvironmentSubscriptionHandlerDependencies,
  assertSubscriptionPairingCurrent
} from './runtime-environment-subscription-setup'
import { ipcMain } from 'electron'
import { abortWhenRendererGone } from '../renderer-lifetime-abort'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

export type {
  RetainedRemoteRuntimeSubscription,
  PendingRuntimeSubscription
} from './runtime-environment-subscription-setup'

export function registerRuntimeEnvironmentSubscriptionHandlers(
  args: RuntimeEnvironmentSubscriptionHandlerDependencies
): void {
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
      args: RuntimeEnvironmentSubscribeArgs
    ): Promise<{ subscriptionId: string; requestId: string } | CrewSubscriptionSetupResult> => {
      const subscriptionId = runtimeEnvironmentSubscriptionId(args)
      const crewResult = args.setupResult === 'crew'
      let failure: RuntimeEnvironmentSetupFailure | undefined
      let setupSignal: AbortSignal | undefined
      let operation: 'environment-resolution' | 'subscription' = 'environment-resolution'
      try {
        assertCrewSubscriptionInputs(
          args,
          crewResult,
          subscriptionId,
          remoteRuntimeSubscriptions,
          pendingSubscriptions
        )
        const { environment, pairingRevision } = resolveSubscriptionEnvironment(
          getUserDataPath(),
          args
        )
        const transportGeneration = getRuntimeEnvironmentTransportGeneration(environment.id)
        const transportIsCurrent = (): boolean =>
          getRuntimeEnvironmentTransportGeneration(environment.id) === transportGeneration
        const sender = event.sender
        const ownerWebContentsId = sender.id
        const setupController = new AbortController()
        setupSignal = setupController.signal
        const assertCrewCurrent = (): void =>
          assertCrewSubscriptionCurrent(
            event,
            sender,
            getUserDataPath,
            environment,
            pairingRevision,
            args,
            transportIsCurrent,
            setupController.signal,
            (value) => {
              failure = value
            }
          )
        if (crewResult) {
          assertCrewCurrent()
        }
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
        try {
          operation = 'subscription'
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
                  // Retirement advances generation before close; the old generation still needs its terminal notification.
                  notifyClosed()
                  return
                }
                if (transportIsCurrent() && !sender.isDestroyed()) {
                  sender.send('runtimeEnvironments:subscriptionEvent', {
                    subscriptionId,
                    ...payload
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
            setupController.signal,
            undefined,
            crewResult
              ? {
                  assertCurrent: assertCrewCurrent,
                  observeFailure: (value) => {
                    failure = value
                  }
                }
              : undefined
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
        assertSettledCrewSubscriptionCurrent(
          crewResult,
          assertCrewCurrent,
          disposeRendererLifetime,
          subscription
        )
        assertSubscriptionPairingCurrent(
          getUserDataPath,
          environment,
          pairingRevision,
          transportIsCurrent,
          crewResult,
          disposeRendererLifetime,
          subscription,
          (value) => {
            failure = value
          }
        )
        if (rendererGone || sender.isDestroyed() || transportClosed) {
          disposeRendererLifetime()
          subscription.close()
          return crewResult
            ? { subscriptionId, ok: true as const }
            : { subscriptionId, requestId: subscription.requestId }
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
        return crewResult
          ? { subscriptionId, ok: true as const }
          : { subscriptionId, requestId: subscription.requestId }
      } catch (error) {
        if (!crewResult) {
          throw error
        }
        return crewSubscriptionSetupFailure(subscriptionId, error, failure, operation, setupSignal)
      }
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
