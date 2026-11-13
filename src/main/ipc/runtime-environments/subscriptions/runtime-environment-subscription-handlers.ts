import { registerRuntimeEnvironmentSubscriptionControls } from './runtime-environment-binary-payload'
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
import type * as SubscriptionSetup from '../../../../shared/remote-runtime/host-catalog/runtime-environment-subscription-setup'
import { ipcMain } from 'electron'
import { abortWhenRendererGone } from '../../renderer-lifetime-abort'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { getRuntimeEnvironmentTransportGeneration } from '../connections/runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from '../requests/runtime-environment-transport-routing'

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
    ): Promise<
      { subscriptionId: string; requestId: string } | SubscriptionSetup.CrewSubscriptionSetupResult
    > => {
      const subscriptionId = runtimeEnvironmentSubscriptionId(args)
      const crewResult = args.setupResult === 'crew'
      let failure: SubscriptionSetup.RuntimeEnvironmentSetupFailure | undefined
      let setupSignal: AbortSignal | undefined
      let operation: 'environment-resolution' | 'subscription' = 'environment-resolution'
      const sender = event.sender
      const setupController = new AbortController()
      const rendererLifetime = abortWhenRendererGone(sender)
      let closeOperation = (): void => {}
      const pending = {
        ownerWebContentsId: sender.id,
        environmentId: args.selector,
        close: (): void => {
          setupController.abort()
          rendererLifetime.dispose()
          if (pendingSubscriptions.get(subscriptionId) === pending) {
            pendingSubscriptions.delete(subscriptionId)
          }
          closeOperation()
        }
      }
      const abortSetup = (): void => pending.close()
      rendererLifetime.signal.addEventListener('abort', abortSetup, { once: true })
      try {
        assertCrewSubscriptionInputs(
          args,
          crewResult,
          subscriptionId,
          remoteRuntimeSubscriptions,
          pendingSubscriptions
        )
        pendingSubscriptions.set(subscriptionId, pending)
        setupSignal = setupController.signal
        const { environment, pairingRevision } = await resolveSubscriptionEnvironment(
          getUserDataPath(),
          args
        )
        setupController.signal.throwIfAborted()
        pending.environmentId = environment.id
        const transportGeneration = getRuntimeEnvironmentTransportGeneration(environment.id)
        const transportIsCurrent = (): boolean =>
          getRuntimeEnvironmentTransportGeneration(environment.id) === transportGeneration
        const ownerWebContentsId = sender.id
        const assertCrewCurrent = async (): Promise<void> =>
          await assertCrewSubscriptionCurrent(
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
          await assertCrewCurrent()
        }
        setupController.signal.throwIfAborted()
        if (
          sender.isDestroyed() ||
          !event.senderFrame ||
          event.senderFrame.detached ||
          event.senderFrame !== sender.mainFrame
        ) {
          throw new Error('The window that started this subscription went away')
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
        let subscription: RemoteRuntimeTransportSubscription | null = null
        const disposeRendererLifetime = (): void => {
          associationObserver?.dispose()
          rendererLifetime.dispose()
          rendererLifetime.signal.removeEventListener('abort', abortSetup)
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
        closeOperation = closeSubscription
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
        try {
          await assertSettledCrewSubscriptionCurrent(
            crewResult,
            assertCrewCurrent,
            disposeRendererLifetime,
            subscription
          )
          if (
            pendingSubscriptions.get(subscriptionId) !== pending ||
            setupController.signal.aborted
          ) {
            subscription.close()
            return crewResult
              ? { subscriptionId, ok: true as const }
              : { subscriptionId, requestId: subscription.requestId }
          }
          await assertSubscriptionPairingCurrent(
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
          if (
            pendingSubscriptions.get(subscriptionId) !== pending ||
            setupController.signal.aborted ||
            rendererGone ||
            sender.isDestroyed() ||
            transportClosed
          ) {
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
        } finally {
          if (pendingSubscriptions.get(subscriptionId) === pending) {
            pendingSubscriptions.delete(subscriptionId)
          }
        }
        return crewResult
          ? { subscriptionId, ok: true as const }
          : { subscriptionId, requestId: subscription.requestId }
      } catch (error) {
        pending.close()
        if (!crewResult) {
          throw error
        }
        return crewSubscriptionSetupFailure(subscriptionId, error, failure, operation, setupSignal)
      } finally {
        if (pendingSubscriptions.get(subscriptionId) === pending) {
          pendingSubscriptions.delete(subscriptionId)
        }
        if (remoteRuntimeSubscriptions.get(subscriptionId)?.setupController !== setupController) {
          rendererLifetime.dispose()
        }
      }
    }
  )
  registerRuntimeEnvironmentSubscriptionControls(pendingSubscriptions, remoteRuntimeSubscriptions)
}
