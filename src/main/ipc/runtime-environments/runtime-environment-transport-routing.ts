import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import { getPreferredPairedRuntimeConnection } from '../../../shared/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { resolveEnvironment, markEnvironmentUsed } from '../../../shared/runtime-environment-store'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { recordRuntimeEnvironmentUsage } from './runtime-environment-usage-record'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../../shared/runtime-rpc-envelope'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../../shared/remote-runtime/remote-runtime-client'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'
import { decodeSessionTabsDeltaEvents } from './runtime-environment-session-tabs-delta-decoding'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import {
  sendRemoteRuntimeConnectionRequestAbortable,
  sendRemoteRuntimeRequestAbortable
} from './runtime-environment-abortable-requests'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import {
  executeSupportRoutedCall,
  shouldUseSharedControlEnvelope,
  shouldRouteCallBySupport,
  shouldRouteSubscriptionBySupport,
  subscribeSupportRoutedRuntimeEnvironment
} from './runtime-environment-support-routing'

const DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS = 15_000

export async function callRuntimeEnvironment(
  userDataPath: string,
  selector: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
  expectedEnvironmentPairingRevision?: number,
  envelope?: RuntimeOrchestrationEnvelope,
  options?: { signal?: AbortSignal; expectedEnvironmentRuntimeId?: string }
): Promise<RuntimeRpcResponse<unknown>> {
  if (method === 'status.get') {
    const environment = resolveEnvironment(userDataPath, selector)
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
        options,
        expectedEnvironmentPairingRevision === undefined
      )
    )
  }
  const environment = resolveEnvironment(userDataPath, selector)
  // Connect failures reject; retain the dispatched endpoint for hints because queued re-pairing can change it.
  let endpoint = getPreferredPairedRuntimeConnection(environment).endpoint
  try {
    return await enqueueRuntimeCall(
      environment.id,
      method,
      async () => {
        const currentEnvironment = await resolveManagedRuntimeEnvironment(
          userDataPath,
          environment.id
        )
        const revisionFailure = runtimeEnvironmentRevisionFailure(
          currentEnvironment,
          expectedEnvironmentPairingRevision,
          method,
          options?.expectedEnvironmentRuntimeId
        )
        if (revisionFailure) {
          return revisionFailure
        }
        const pairedConnection = getPreferredPairedRuntimeConnection(currentEnvironment)
        endpoint = pairedConnection.endpoint
        const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
        const sharedControlEnvelope = shouldUseSharedControlEnvelope(method, params, envelope)
        if (envelope && !sharedControlEnvelope) {
          const response = await sendRemoteRuntimeRequestAbortable(
            pairedConnection,
            method,
            params,
            effectiveTimeoutMs,
            envelope,
            options?.signal,
            ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
          )
          markEnvironmentUsedFromResponse(userDataPath, currentEnvironment.id, response)
          return response
        }
        if (shouldUseCachedRequestConnection(method)) {
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
            method,
            params,
            timeoutMs: effectiveTimeoutMs,
            expectedPairingRevision: expectedEnvironmentPairingRevision,
            expectedRuntimeId: options?.expectedEnvironmentRuntimeId,
            envelope: sharedControlEnvelope,
            signal: options?.signal
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
          ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
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
        | { type: 'response'; response: RuntimeRpcResponse<unknown> }
        | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
        | { type: 'error'; code: string; message: string }
        | { type: 'close' }
    ) => void
    onClose: () => void
  },
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal
): Promise<RemoteRuntimeSubscription> {
  const callbacks = {
    ...rawCallbacks,
    onEvent: decodeSessionTabsDeltaEvents(method, rawCallbacks.onEvent)
  }
  const environment = await resolveManagedRuntimeEnvironment(userDataPath, selector)
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
    onResponse: (response: RuntimeRpcResponse<unknown>) => {
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
    return await subscribeRemoteRuntimeRequest(
      pairedConnection,
      method,
      params,
      effectiveTimeoutMs,
      callbacksWithMarkUsed,
      { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, signal }
    )
  } catch (error) {
    if (error instanceof Error) {
      error.message = withRuntimeUnreachableHint(
        environment,
        error.message,
        pairedConnection.endpoint
      )
    }
    throw error
  }
}

function markEnvironmentUsedFromResponse(
  userDataPath: string,
  environmentId: string,
  response: RuntimeRpcResponse<unknown>
): void {
  if (response.ok === true) {
    markEnvironmentUsed(userDataPath, environmentId, { runtimeId: response._meta.runtimeId })
  }
}

function shouldUseCachedRequestConnection(method: string): boolean {
  return method === 'terminal.send' || method === 'terminal.updateViewport'
}
