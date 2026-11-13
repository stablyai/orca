import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import {
  type RuntimeEnvironmentSetupFailure,
  runtimeEnvironmentSetupFailure
} from '../../../shared/remote-runtime/host-catalog/runtime-environment-subscription-setup'
import { assertCrewSourceCurrent } from './runtime-environment-subscription-setup'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  resolveManagedRuntimeEnvironment,
  type ManagedRuntimeCallPreparation
} from './runtime-environment-managed-tunnel'
import { recordRuntimeEnvironmentUsage } from '../../../shared/remote-runtime/host-store/runtime-environment-usage-record'
import type * as Rpc from '../../../shared/runtime-rpc-envelope'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RemoteRuntimeTransportSubscription } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'
import { decodeRuntimeEnvironmentSubscriptionEvents } from './runtime-environment-subscription-events'
import { runtimeCallQueuePool } from './runtime-environment-call-queue'
import { isTimedPRRead } from '../../../shared/runtime-rpc-call-queue'
import { enqueueRuntimeSubscription } from '../../../shared/runtime-rpc-subscription-queue'
import {
  shouldRouteSubscriptionBySupport,
  subscribeSupportRoutedRuntimeEnvironment
} from './runtime-environment-support-routing'

const DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS = 15_000

export async function subscribeRuntimeEnvironment(
  userDataPath: string,
  selector: string,
  method: string,
  params: unknown,
  timeoutMs: number | undefined,
  rawCallbacks: {
    onEvent: (
      payload:
        | { type: 'response'; response: Rpc.RuntimeRpcResponse<unknown> }
        | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
        | { type: 'error'; code: string; message: string }
        | { type: 'close' }
    ) => void
    onClose: () => void
  },
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
  preparation?: ManagedRuntimeCallPreparation,
  crewAttempt?: {
    assertCurrent: () => void
    observeFailure: (failure: RuntimeEnvironmentSetupFailure) => void
  }
): Promise<RemoteRuntimeTransportSubscription> {
  let completeTimed = (): void => {}
  const callbacks = {
    onEvent: decodeRuntimeEnvironmentSubscriptionEvents(
      method,
      (event) => {
        if (event.type !== 'binary') {
          completeTimed()
        }
        rawCallbacks.onEvent(event)
      },
      isCurrent
    ),
    onClose: () => {
      completeTimed()
      rawCallbacks.onClose()
    }
  }
  crewAttempt?.assertCurrent()
  const environment = crewAttempt
    ? resolveEnvironment(userDataPath, selector)
    : await resolveManagedRuntimeEnvironment(userDataPath, selector, preparation, method, signal)
  crewAttempt?.assertCurrent()
  if (crewAttempt) {
    assertCrewSourceCurrent(environment)
  }
  const pairedConnection = getPreferredPairedRuntimeConnection(environment)
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
  let markedUsed = false
  const markUsedOnce = (runtimeId: string): void => {
    if (markedUsed || !isCurrent()) {
      return
    }
    markedUsed = true
    recordRuntimeEnvironmentUsage(userDataPath, environment.id, { runtimeId })
  }
  const callbacksWithMarkUsed = {
    onResponse: (response: Rpc.RuntimeRpcResponse<unknown>) => {
      if (
        crewAttempt &&
        response._meta?.runtimeId != null &&
        response._meta.runtimeId !== environment.runtimeId
      ) {
        throw new RemoteRuntimeClientError(
          'runtime_environment_changed',
          'Runtime environment identity changed; refresh and try again'
        )
      }
      if (response.ok === true) {
        markUsedOnce(response._meta.runtimeId)
      }
      callbacks.onEvent({ type: 'response' as const, response })
    },
    onBinary: (bytes: Uint8Array<ArrayBufferLike>) =>
      callbacks.onEvent({ type: 'binary' as const, bytes }),
    onError: (error: { code: string; message: string }) =>
      callbacks.onEvent({
        type: 'error' as const,
        code: error.code,
        message: withRuntimeUnreachableHint(environment, error.message, pairedConnection.endpoint)
      }),
    onClose: () => {
      callbacks.onEvent({ type: 'close' as const })
      callbacks.onClose()
    }
  }
  // Initial connection failures reject; midstream errors use onError above.
  const connect = async (): Promise<RemoteRuntimeTransportSubscription> => {
    try {
      if (shouldRouteSubscriptionBySupport(method)) {
        return await subscribeSupportRoutedRuntimeEnvironment({
          userDataPath,
          environment,
          method,
          params,
          timeoutMs: effectiveTimeoutMs,
          callbacks,
          isCurrent,
          signal
        })
      }
      const subscription = await subscribeRemoteRuntimeTransport(
        pairedConnection,
        method,
        params,
        effectiveTimeoutMs,
        callbacksWithMarkUsed,
        { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, signal }
      )
      if (crewAttempt) {
        try {
          throwIfSignalAborted(signal)
          crewAttempt.assertCurrent()
          assertCrewSourceCurrent(environment)
        } catch (error) {
          subscription.close()
          throw error
        }
      }
      return subscription
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        error.message = withRuntimeUnreachableHint(
          environment,
          error.message,
          pairedConnection.endpoint
        )
      }
      crewAttempt?.observeFailure(runtimeEnvironmentSetupFailure(error, 'subscription'))
      throw error
    }
  }
  if (!isTimedPRRead(method, params)) {
    return connect()
  }
  const subscription = await enqueueRuntimeSubscription(
    runtimeCallQueuePool,
    environment.id,
    method,
    params,
    (complete) => {
      completeTimed = complete
      return connect()
    },
    (handle) => handle.close(),
    signal
  )
  return { ...subscription, close: () => completeTimed() }
}
