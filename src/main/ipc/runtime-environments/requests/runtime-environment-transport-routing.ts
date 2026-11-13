import {
  markEnvironmentUsedFromResponse,
  shouldUseCachedRequestConnection
} from './runtime-environment-usage-response'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { throwIfSignalAborted } from '../../../../shared/abort-signal-reason'
import {
  type RuntimeEnvironmentSetupFailure,
  runtimeEnvironmentSetupFailure
} from '../../../../shared/remote-runtime/host-catalog/runtime-environment-subscription-setup'
import { assertCrewSourceCurrent } from '../subscriptions/runtime-environment-subscription-setup'
import { getRuntimeEnvironmentStatus } from '../status/runtime-environment-status-probe'
import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { prepareFencedRuntimeRequest } from './runtime-environment-request-preparation'
import {
  requireWslHostWithoutStart,
  resolveManagedRuntimeEnvironment,
  type ManagedRuntimeCallPreparation
} from '../managed-orcad/runtime-environment-managed-tunnel'
import { recordRuntimeEnvironmentUsage } from '../../../../shared/remote-runtime/host-store/runtime-environment-usage-record'
import type * as Rpc from '../../../../shared/runtime-rpc-envelope'
import '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'
import { decodeRuntimeEnvironmentSubscriptionEvents } from '../subscriptions/runtime-environment-subscription-events'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import {
  sendRemoteRuntimeConnectionRequestAbortable,
  sendRemoteRuntimeRequestAbortable
} from './runtime-environment-abortable-requests'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import {
  executeSupportRoutedCall,
  shouldRouteCallBySupport,
  shouldRouteSubscriptionBySupport,
  subscribeSupportRoutedRuntimeEnvironment
} from './runtime-environment-support-routing'
import { shouldUseSharedControlEnvelope } from '../connections/runtime-environment-shared-control-envelope'
import { sendEnvelopedOneShotCall } from './runtime-environment-runtime-pinned-send'

const DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS = 15_000

export async function callRuntimeEnvironment(
  userDataPath: string,
  selector: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
  expectedEnvironmentPairingRevision?: number,
  envelope?: Rpc.RuntimeOrchestrationEnvelope,
  options?: {
    prepareGuard?: Rpc.RuntimeRequestGuard
    prepareRequest?: Rpc.RuntimeRequestPreparation
    signal?: AbortSignal
    expectedEnvironmentRuntimeId?: string
    preparation?: ManagedRuntimeCallPreparation
  }
): Promise<Rpc.RuntimeRpcResponse<unknown>> {
  if (method === 'status.get') {
    let statusOptions = options
    // Why: the status probe dials on its own, so a no-start caller's WSL host is checked first.
    if (options?.preparation) {
      const { preparation, ...rest } = options
      await requireWslHostWithoutStart(userDataPath, selector, preparation)
      statusOptions = rest
    }
    const environment = await resolveEnvironment(userDataPath, selector)
    const failure = runtimeEnvironmentRevisionFailure(
      environment,
      expectedEnvironmentPairingRevision,
      method
    )
    return (
      failure ??
      getRuntimeEnvironmentStatus(
        userDataPath,
        selector,
        timeoutMs,
        statusOptions,
        expectedEnvironmentPairingRevision === undefined
      )
    )
  }
  const environment = await resolveEnvironment(userDataPath, selector)
  // Connect failures reject; retain the dispatched endpoint for hints because queued re-pairing can change it.
  let endpoint = getPreferredPairedRuntimeConnection(environment).endpoint
  try {
    return await enqueueRuntimeCall(
      environment.id,
      method,
      async () => {
        const prepared = await prepareFencedRuntimeRequest(
          userDataPath,
          environment.id,
          method,
          options?.preparation,
          {
            pairingRevision: expectedEnvironmentPairingRevision,
            runtimeId: options?.expectedEnvironmentRuntimeId
          },
          options?.signal
        )
        if (prepared.failure) {
          return prepared.failure
        }
        const { environment: currentEnvironment, expected } = prepared
        const pairedConnection = getPreferredPairedRuntimeConnection(currentEnvironment)
        endpoint = pairedConnection.endpoint
        const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
        const sharedControlEnvelope = shouldUseSharedControlEnvelope(method, params, envelope)
        const call = {
          method,
          params,
          timeoutMs: effectiveTimeoutMs,
          signal: options?.signal,
          prepareGuard: options?.prepareGuard,
          prepareRequest: options?.prepareRequest
        }
        if (envelope && !sharedControlEnvelope) {
          const response = await sendEnvelopedOneShotCall(
            { environment: currentEnvironment, connection: pairedConnection },
            { ...call, envelope },
            expected.runtimeId
          )
          markEnvironmentUsedFromResponse(userDataPath, currentEnvironment.id, response)
          return response
        }
        if (
          shouldUseCachedRequestConnection(method) &&
          !options?.prepareGuard &&
          !options?.prepareRequest
        ) {
          const response = await sendRemoteRuntimeConnectionRequestAbortable(
            currentEnvironment.id,
            pairedConnection,
            method,
            params,
            effectiveTimeoutMs,
            options?.signal
          )
          markEnvironmentUsedFromResponse(userDataPath, currentEnvironment.id, response)
          return response
        }
        if (shouldRouteCallBySupport(method, currentEnvironment.id)) {
          return executeSupportRoutedCall({
            userDataPath,
            environment: currentEnvironment,
            ...call,
            expectedPairingRevision: expected.pairingRevision,
            expectedRuntimeId: expected.runtimeId,
            envelope: sharedControlEnvelope
          })
        }
        // One-shot startup/control RPCs keep repo hydration independent of stale terminal-control sockets.
        const response = await sendRemoteRuntimeRequestAbortable(
          pairedConnection,
          method,
          params,
          effectiveTimeoutMs,
          sharedControlEnvelope,
          options?.signal,
          ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
          options?.prepareRequest,
          options?.prepareGuard
        )
        markEnvironmentUsedFromResponse(userDataPath, currentEnvironment.id, response)
        return response
      },
      options?.signal
    )
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      error.message = withRuntimeUnreachableHint(environment, error.message, endpoint)
    }
    throw error
  }
}

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
    assertCurrent: () => Promise<void>
    observeFailure: (failure: RuntimeEnvironmentSetupFailure) => void
  }
): Promise<RemoteRuntimeTransportSubscription> {
  const callbacks = {
    ...rawCallbacks,
    onEvent: decodeRuntimeEnvironmentSubscriptionEvents(method, rawCallbacks.onEvent, isCurrent)
  }
  await crewAttempt?.assertCurrent()
  const environment = crewAttempt
    ? await resolveEnvironment(userDataPath, selector)
    : await resolveManagedRuntimeEnvironment(userDataPath, selector, preparation, method, signal)
  await crewAttempt?.assertCurrent()
  throwIfSignalAborted(signal)
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
        await crewAttempt.assertCurrent()
        throwIfSignalAborted(signal)
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
