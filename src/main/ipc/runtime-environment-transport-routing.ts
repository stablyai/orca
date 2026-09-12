import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { resolveEnvironment, markEnvironmentUsed } from '../../shared/runtime-environment-store'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../shared/runtime-rpc-envelope'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { withRemoteRuntimeTailscaleHint } from '../../shared/remote-runtime-tailscale-hint'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import {
  sendRemoteRuntimeConnectionRequestAbortable,
  sendRemoteRuntimeRequestAbortable
} from './runtime-environment-abortable-requests'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import { resetSharedControlSupport } from './runtime-environment-shared-control-support'
import {
  executeSupportRoutedCall,
  shouldUseSharedControlEnvelope,
  shouldRouteCallBySupport,
  shouldRouteSubscriptionBySupport,
  subscribeSupportRoutedRuntimeEnvironment
} from './runtime-environment-support-routing'

const DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS = 15_000

export { resetSharedControlSupport }

export { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'

export async function callRuntimeEnvironment(
  userDataPath: string,
  selector: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
  expectedEnvironmentPairingRevision?: number,
  envelope?: RuntimeOrchestrationEnvelope,
  options?: { signal?: AbortSignal }
): Promise<RuntimeRpcResponse<unknown>> {
  if (method === 'status.get') {
    const environment = resolveEnvironment(userDataPath, selector)
    const failure = runtimeEnvironmentRevisionFailure(
      environment,
      expectedEnvironmentPairingRevision,
      method
    )
    return failure ?? getRuntimeEnvironmentStatus(userDataPath, selector, timeoutMs, options)
  }
  const environment = resolveEnvironment(userDataPath, selector)
  // Queued calls re-resolve pairing; use their actual endpoint for connection-error hints.
  let endpoint = getPreferredPairingOffer(environment).endpoint
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
          method
        )
        if (revisionFailure) {
          return revisionFailure
        }
        const pairing = getPreferredPairingOffer(currentEnvironment)
        endpoint = pairing.endpoint
        const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
        const sharedControlEnvelope = shouldUseSharedControlEnvelope(method, params, envelope)
        if (envelope && !sharedControlEnvelope) {
          const response = await sendRemoteRuntimeRequestAbortable(
            pairing,
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
            pairing,
            method,
            params,
            effectiveTimeoutMs,
            options?.signal
          )
          markEnvironmentUsedFromResponse(userDataPath, currentEnvironment.id, response)
          return response
        }
        if (shouldRouteCallBySupport(method)) {
          return executeSupportRoutedCall({
            userDataPath,
            environment: currentEnvironment,
            method,
            params,
            timeoutMs: effectiveTimeoutMs,
            expectedPairingRevision: expectedEnvironmentPairingRevision,
            envelope: sharedControlEnvelope,
            signal: options?.signal
          })
        }
        // Why: startup/control-plane RPCs use the proven one-shot path so repo
        // hydration cannot be coupled to a stale terminal-control connection.
        const response = await sendRemoteRuntimeRequestAbortable(
          pairing,
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
      error.message = withRemoteRuntimeTailscaleHint(error.message, endpoint)
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
  callbacks: {
    onEvent: (
      payload:
        | { type: 'response'; response: RuntimeRpcResponse<unknown> }
        | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
        | { type: 'error'; code: string; message: string }
        | { type: 'close' }
    ) => void
    onClose: () => void
  },
  isCurrent: () => boolean = () => true
): Promise<RemoteRuntimeSubscription> {
  const environment = await resolveManagedRuntimeEnvironment(userDataPath, selector)
  const pairing = getPreferredPairingOffer(environment)
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
  let markedUsed = false
  const markUsedOnce = (runtimeId: string): void => {
    if (markedUsed || !isCurrent()) {
      return
    }
    markedUsed = true
    markEnvironmentUsed(userDataPath, environment.id, { runtimeId })
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
        message: withRemoteRuntimeTailscaleHint(error.message, pairing.endpoint)
      }),
    onClose: () => {
      callbacks.onEvent({ type: 'close' as const })
      callbacks.onClose()
    }
  }
  // Why: an initial-connect failure rejects (mid-stream drops go through
  // onError above), so the hint is applied to the thrown error here too.
  try {
    if (shouldRouteSubscriptionBySupport(method)) {
      return await subscribeSupportRoutedRuntimeEnvironment({
        userDataPath,
        environment,
        method,
        params,
        timeoutMs: effectiveTimeoutMs,
        callbacks,
        isCurrent
      })
    }
    return await subscribeRemoteRuntimeRequest(
      pairing,
      method,
      params,
      effectiveTimeoutMs,
      callbacksWithMarkUsed,
      { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
    )
  } catch (error) {
    if (error instanceof Error) {
      error.message = withRemoteRuntimeTailscaleHint(error.message, pairing.endpoint)
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
