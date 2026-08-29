import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { resolveEnvironment, markEnvironmentUsed } from '../../shared/runtime-environment-store'
import { isOrchestrationMutation } from '../../shared/orchestration-rpc-contract'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { withRemoteRuntimeTailscaleHint } from '../../shared/remote-runtime-tailscale-hint'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import {
  reconnectRemoteRuntimeSharedControlConnection,
  subscribeRemoteRuntimeSharedControlRequest
} from './runtime-environment-request-connections'
import {
  sendRemoteRuntimeConnectionRequestAbortable,
  sendRemoteRuntimeRequestAbortable,
  sendRemoteRuntimeSharedControlRequestAbortable
} from './runtime-environment-abortable-requests'
import { attachRemoteControlDiagnostics } from './runtime-environment-status-diagnostics'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import { withTailscaleHintForResponse } from './runtime-environment-tailscale-response'
import {
  clearSharedControlSupport,
  resetSharedControlSupport,
  supportsSharedControl
} from './runtime-environment-shared-control-support'

const DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS = 15_000

export { clearSharedControlSupport, resetSharedControlSupport }

export async function getRuntimeEnvironmentStatus(
  userDataPath: string,
  selector: string,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<RuntimeStatus>> {
  const environment = resolveEnvironment(userDataPath, selector)
  const pairing = getPreferredPairingOffer(environment)
  let response: RuntimeRpcResponse<RuntimeStatus>
  try {
    response = await sendRemoteRuntimeRequest<RuntimeStatus>(
      pairing,
      'status.get',
      undefined,
      timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
  } catch (error) {
    // Why: the status UI needs shared-control diagnostics most when the
    // fresh status probe failed and the host is reconnecting/offline.
    return attachRemoteControlDiagnostics(
      withTailscaleHintForResponse(
        {
          id: 'status.get',
          ok: false,
          error: {
            code: 'runtime_unavailable',
            message: error instanceof Error ? error.message : String(error)
          },
          _meta: { runtimeId: environment.runtimeId }
        },
        pairing.endpoint
      ),
      environment.id
    )
  }
  if (response.ok === true) {
    markEnvironmentUsed(userDataPath, environment.id, {
      runtimeId: response._meta.runtimeId,
      pairedDeviceId: response.result.pairedDeviceId
    })
    reconnectRemoteRuntimeSharedControlConnection(environment.id)
  }
  return attachRemoteControlDiagnostics(
    withTailscaleHintForResponse(response, pairing.endpoint),
    environment.id
  )
}

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
  const environment = resolveEnvironment(userDataPath, selector)
  // Why: connection failures reject (they don't resolve as ok:false), so the
  // Tailscale hint is applied to the thrown error here — wrapping the resolved
  // value would miss the in-use connect/timeout case the toast surfaces.
  // Track the endpoint the queued closure actually used: it re-resolves the
  // environment, so a re-pair between enqueue and dispatch can change it.
  let endpoint = getPreferredPairingOffer(environment).endpoint
  try {
    return await enqueueRuntimeCall(
      environment.id,
      method,
      async () => {
        const currentEnvironment = resolveEnvironment(userDataPath, environment.id)
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
        if (
          method !== 'status.get' &&
          !shouldUseOneShotRequest(method) &&
          (await waitForPromiseWithSignal(
            supportsSharedControl(userDataPath, currentEnvironment, pairing, effectiveTimeoutMs),
            options?.signal
          ))
        ) {
          const response = await sendRemoteRuntimeSharedControlRequestAbortable(
            currentEnvironment.id,
            pairing,
            method,
            params,
            effectiveTimeoutMs,
            sharedControlEnvelope,
            options?.signal
          )
          markEnvironmentUsedFromResponse(userDataPath, currentEnvironment.id, response)
          return response
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
  }
): Promise<RemoteRuntimeSubscription> {
  const environment = resolveEnvironment(userDataPath, selector)
  const pairing = getPreferredPairingOffer(environment)
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS
  let markedUsed = false
  const markUsedOnce = (runtimeId: string): void => {
    if (markedUsed) {
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
    if (
      shouldUseSharedControlSubscription(method) &&
      !shouldKeepDedicatedSubscriptionSocket(method) &&
      (await supportsSharedControl(userDataPath, environment, pairing, effectiveTimeoutMs))
    ) {
      return await subscribeRemoteRuntimeSharedControlRequest(
        environment.id,
        pairing,
        method,
        params,
        effectiveTimeoutMs,
        callbacksWithMarkUsed
      )
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

function shouldUseSharedControlEnvelope(
  method: string,
  params: unknown,
  envelope: RuntimeOrchestrationEnvelope | undefined
): RuntimeOrchestrationEnvelope | undefined {
  return envelope && method.startsWith('orchestration.') && !isOrchestrationMutation(method, params)
    ? envelope
    : undefined
}

function shouldUseOneShotRequest(method: string): boolean {
  // Why: snapshot recovery must remain available while a retained shared-control stream is reconnecting after a HUB restart.
  return method === 'session.tabs.list' || method === 'session.tabs.listAll'
}

function shouldKeepDedicatedSubscriptionSocket(method: string): boolean {
  return method === 'browser.screencast' || method === 'terminal.multiplex'
}

function shouldUseSharedControlSubscription(method: string): boolean {
  return (
    method === 'runtime.clientEvents.subscribe' ||
    method === 'session.tabs.subscribe' ||
    method === 'session.tabs.subscribeAll' ||
    method === 'accounts.subscribe' ||
    method === 'notifications.subscribe' ||
    method === 'files.watch'
  )
}
