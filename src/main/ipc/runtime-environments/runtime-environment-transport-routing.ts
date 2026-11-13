import { getRuntimeEnvironmentStatus } from './runtime-environment-status-probe'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { prepareFencedRuntimeRequest } from './runtime-environment-request-preparation'
import {
  requireWslHostWithoutStart,
  type ManagedRuntimeCallPreparation
} from './runtime-environment-managed-tunnel'
import { recordRuntimeEnvironmentUsage } from '../../../shared/remote-runtime/host-store/runtime-environment-usage-record'
import type * as Rpc from '../../../shared/runtime-rpc-envelope'
import '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import {
  sendRemoteRuntimeConnectionRequestAbortable,
  sendRemoteRuntimeRequestAbortable
} from './runtime-environment-abortable-requests'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import {
  executeSupportRoutedCall,
  shouldRouteCallBySupport
} from './runtime-environment-support-routing'
import { shouldUseSharedControlEnvelope } from './runtime-environment-shared-control-envelope'
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
        statusOptions,
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
          options?.prepareRequest
        )
        markEnvironmentUsedFromResponse(userDataPath, currentEnvironment.id, response)
        return response
      },
      options?.signal,
      params
    )
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      error.message = withRuntimeUnreachableHint(environment, error.message, endpoint)
    }
    throw error
  }
}

export { subscribeRuntimeEnvironment } from './runtime-environment-subscription-routing'

function markEnvironmentUsedFromResponse(
  userDataPath: string,
  environmentId: string,
  response: Rpc.RuntimeRpcResponse<unknown>
): void {
  if (response.ok === true) {
    recordRuntimeEnvironmentUsage(userDataPath, environmentId, {
      runtimeId: response._meta.runtimeId
    })
  }
}

function shouldUseCachedRequestConnection(method: string): boolean {
  return method === 'terminal.send' || method === 'terminal.updateViewport'
}
