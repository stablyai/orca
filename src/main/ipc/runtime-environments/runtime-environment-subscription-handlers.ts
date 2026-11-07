import {
  assertCrewSubscriptionInputs,
  runtimeEnvironmentSubscriptionId,
  assertSettledCrewSubscriptionCurrent,
  assertCrewSubscriptionCurrent,
  resolveSubscriptionEnvironment,
  crewSubscriptionSetupFailure,
  type RuntimeEnvironmentSubscribeArgs,
  type RuntimeEnvironmentSubscriptionHandlerDependencies,
  assertSubscriptionPairingCurrent
} from './runtime-environment-subscription-setup'
import type * as SubscriptionSetup from '../../../shared/remote-runtime/host-catalog/runtime-environment-subscription-setup'
import { ipcMain } from 'electron'
import { abortWhenRendererGone } from '../renderer-lifetime-abort'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import { registerSubscriptionBinaryHandler } from './runtime-environment-binary-payload'
import { acceptRemoteGeneratedInput } from './runtime-environment-generated-input-notice-hosts'
import { generatedInputDispatch } from './runtime-environment-generated-input-dispatch'

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
    createAssociationObserver,
    acceptGeneratedInput
  } = args
  ipcMain.handle(
    'runtimeEnvironments:subscribe',
    async (
      event,
      args: RuntimeEnvironmentSubscribeArgs
    ): Promise<
      { subscriptionId: string; requestId: string } | SubscriptionSetup.CrewSubscriptionSetupResult
    > => {
      const subscriptionId = runtimeEnvironmentSubscriptionId(args)
      const crewResult = args.setupResult === 'crew'
      let failure: SubscriptionSetup.RuntimeEnvironmentSetupFailure | undefined
      let setupSignal: AbortSignal | undefined
      let operation: 'environment-resolution' | 'subscription' = 'environment-resolution'
      // Before any refusal or wait: a cancellable generated request is held by this window's runtime.
      const { observer: observeGeneratedInput, pairingRevision: pinned } =
        acceptRemoteGeneratedInput(acceptGeneratedInput, event, args) ?? {}
      try {
        assertCrewSubscriptionInputs(
          args,
          crewResult,
          subscriptionId,
          remoteRuntimeSubscriptions,
          pendingSubscriptions
        )
        // The pairing this window's request was first resolved to holds for every call of it.
        const resolved = resolveSubscriptionEnvironment(getUserDataPath(), args, pinned)
        const { environment, pairingRevision } = resolved
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
        // A generated request's own end closes it if its frame has not left by then.
        const dispatch = generatedInputDispatch(args.method, args.params, args.generatedInputEnd)
        const disposeRendererLifetime = (): void => {
          dispatch?.dispose()
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
        dispatch?.signal.addEventListener('abort', closeSubscription, { once: true })
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
                // The host's answer settles the window's record even when the window went away.
                if (payload.type === 'response') {
                  observeGeneratedInput?.answered(payload.response)
                }
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
                observeGeneratedInput?.answered(null)
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
          observeGeneratedInput?.answered(null)
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
        observeGeneratedInput?.answered(null)
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
  registerSubscriptionBinaryHandler(remoteRuntimeSubscriptions)
}
