import type { RpcEnvelopeMeta, RpcMethod, RpcRequest, RpcResponse } from './core'
import { successResponse } from './errors'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import type {
  DurableMutationInvocation,
  OrchestrationMutationExecutor
} from './orchestration-mutation-executor'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import type { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { routeDispatcherClientHostedBrowserRpc } from './dispatcher-client-browser-routing'
import { needsLocalCallerFingerprint } from './dispatcher-caller-fingerprint'

export type UnaryRpcExecutionDeps = {
  runtime: OrcaRuntimeService
  orchestrationMutations: OrchestrationMutationExecutor
  legacyOrchestration: OrchestrationLegacyCompatibility
}

// Why: non-streaming methods reach the dispatcher over both transports; the streaming
// transport just serializes the response instead of returning it.
export async function executeUnaryRpc(
  deps: UnaryRpcExecutionDeps,
  request: RpcRequest,
  method: RpcMethod,
  params: unknown,
  meta: RpcEnvelopeMeta,
  options: RpcDispatchStreamingOptions | undefined
): Promise<RpcResponse> {
  const { runtime, orchestrationMutations, legacyOrchestration } = deps
  const isEmulatorMethod = request.method.startsWith('emulator.')
  if (isEmulatorMethod) {
    emulatorProbe(`rpc ${request.method}`, request.params)
  }
  try {
    const clientHostedBrowser = await routeDispatcherClientHostedBrowserRpc(
      runtime,
      request.method,
      params
    )
    if (clientHostedBrowser.handled) {
      recordRuntimeFeatureInteraction(
        runtime,
        request.method,
        clientHostedBrowser.result,
        undefined,
        request.params
      )
      return successResponse(request.id, meta, clientHostedBrowser.result)
    }

    const compatibility = await legacyOrchestration.tryHandle(request, params, options?.signal)
    if (compatibility.handled) {
      return successResponse(request.id, meta, compatibility.result)
    }

    const effectiveParams = compatibility.params ?? params
    const legacyCoordinator = legacyOrchestration.createCoordinatorInvocation(
      request,
      compatibility.legacyCoordinatorAuthority
    )
    const authenticatedCallerFingerprint =
      options?.authenticatedCallerFingerprint ??
      (needsLocalCallerFingerprint(request, effectiveParams)
        ? orchestrationMutations.getLocalAuthenticatedCallerFingerprint()
        : undefined)
    const invoke = (mutation?: DurableMutationInvocation) => {
      const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
      return method.handler(effectiveParams, {
        runtime,
        signal: options?.signal,
        requestId: request.id,
        connectionId: options?.connectionId,
        clientId: options?.clientId,
        pairedDeviceId: options?.pairedDeviceId,
        clientKind: options?.clientKind,
        clientCapabilities: options?.clientCapabilities,
        orchestrationCapability: request.orchestrationCapability,
        authenticatedCallerFingerprint:
          mutation?.identity.callerFingerprint ??
          legacyCoordinator?.mutationCallerFingerprint ??
          authenticatedCallerFingerprint,
        recordMutationReceipt: mutation?.recordReceipt,
        orchestrationMutation: mutation?.identity,
        pairing: options?.pairing,
        sendBinary: options?.sendBinary,
        registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
        registerBinaryMessageHandler: options?.registerBinaryMessageHandler,
        legacyCoordinatorRunId,
        legacyCoordinatorAuthority: legacyCoordinator?.authority,
        revalidateLegacyCoordinator: legacyCoordinator?.revalidate,
        orchestrationCompatibilityCallerAuthority:
          compatibility.orchestrationCompatibilityCallerAuthority,
        orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
      })
    }
    const result = await orchestrationMutations.run(
      request,
      effectiveParams,
      invoke,
      legacyCoordinator?.mutationCallerFingerprint ?? authenticatedCallerFingerprint
    )
    recordRuntimeFeatureInteraction(runtime, request.method, result, undefined, request.params)
    return successResponse(request.id, meta, result)
  } catch (error) {
    if (isEmulatorMethod) {
      emulatorProbeError(`rpc ${request.method}`, error, { params: request.params })
    }
    return mapDispatcherError(request, meta, error)
  }
}
