import {
  buildRegistry,
  isStreamingMethod,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse
} from './core'

import { errorResponse, successResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  getOrchestrationMutationExecutor,
  type OrchestrationMutationExecutor,
  type DurableMutationInvocation
} from './orchestration-mutation-executor'
import { orchestrationMigrationFence } from './orchestration-contract-fence'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import { routeDispatcherClientHostedBrowserRpc } from './dispatcher-client-browser-routing'
import { needsLocalCallerFingerprint } from './dispatcher-caller-fingerprint'
import { RpcStreamingDispatcher } from './rpc-streaming-dispatcher'

export type DispatcherOptions = { runtime: OrcaRuntimeService; methods?: readonly RpcAnyMethod[] }

type DispatchCallOptions = RpcDispatchStreamingOptions

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry
  private readonly orchestrationMutations: OrchestrationMutationExecutor
  private readonly legacyOrchestration: OrchestrationLegacyCompatibility
  private readonly streamingDispatcher: RpcStreamingDispatcher

  constructor({ runtime, methods = ALL_RPC_METHODS }: DispatcherOptions) {
    this.runtime = runtime
    this.registry = buildRegistry(methods)
    this.orchestrationMutations = getOrchestrationMutationExecutor(runtime)
    this.legacyOrchestration = new OrchestrationLegacyCompatibility(runtime)
    this.streamingDispatcher = new RpcStreamingDispatcher({
      runtime,
      registry: this.registry,
      orchestrationMutations: this.orchestrationMutations,
      legacyOrchestration: this.legacyOrchestration,
      meta: () => this.meta()
    })
  }

  async dispatch(request: RpcRequest, options?: DispatchCallOptions): Promise<RpcResponse> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      return errorResponse(
        request.id,
        meta,
        'method_not_found',
        `Unknown method: ${request.method}`
      )
    }

    const migrationFence = orchestrationMigrationFence(request, meta)
    if (migrationFence) {
      return migrationFence
    }

    const parsedParams = parseRpcRequestParams(request, method, meta)
    if (parsedParams.error) {
      return parsedParams.error
    }

    if (isStreamingMethod(method)) {
      return errorResponse(
        request.id,
        meta,
        'method_not_supported',
        `Method ${request.method} requires a streaming transport`
      )
    }

    if (request.method.startsWith('emulator.')) {
      emulatorProbe(`rpc ${request.method}`, request.params)
    }
    try {
      const clientHostedBrowser = await routeDispatcherClientHostedBrowserRpc(
        this.runtime,
        request.method,
        parsedParams.value
      )
      if (clientHostedBrowser.handled) {
        recordRuntimeFeatureInteraction(
          this.runtime,
          request.method,
          clientHostedBrowser.result,
          undefined,
          request.params
        )
        return successResponse(request.id, meta, clientHostedBrowser.result)
      }
      const compatibility = await this.legacyOrchestration.tryHandle(
        request,
        parsedParams.value,
        options?.signal
      )
      if (compatibility.handled) {
        return successResponse(request.id, meta, compatibility.result)
      }
      const effectiveParams = compatibility.params ?? parsedParams.value
      const legacyCoordinator = this.legacyOrchestration.createCoordinatorInvocation(
        request,
        compatibility.legacyCoordinatorAuthority
      )
      const authenticatedCallerFingerprint =
        options?.authenticatedCallerFingerprint ??
        (needsLocalCallerFingerprint(request, effectiveParams)
          ? this.orchestrationMutations.getLocalAuthenticatedCallerFingerprint()
          : undefined)
      const invoke = (mutation?: DurableMutationInvocation) => {
        const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
        return method.handler(effectiveParams, {
          runtime: this.runtime,
          signal: options?.signal,
          connectionId: options?.connectionId,
          requestId: request.id,
          clientId: options?.clientId,
          clientKind: options?.clientKind,
          clientCapabilities: options?.clientCapabilities,
          updateClientCapabilities: options?.updateClientCapabilities,
          orchestrationCapability: request.orchestrationCapability,
          authenticatedCallerFingerprint:
            mutation?.identity.callerFingerprint ??
            legacyCoordinator?.mutationCallerFingerprint ??
            authenticatedCallerFingerprint,
          recordMutationReceipt: mutation?.recordReceipt,
          orchestrationMutation: mutation?.identity,
          legacyCoordinatorRunId,
          legacyCoordinatorAuthority: legacyCoordinator?.authority,
          revalidateLegacyCoordinator: legacyCoordinator?.revalidate,
          orchestrationCompatibilityCallerAuthority:
            compatibility.orchestrationCompatibilityCallerAuthority,
          orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
        })
      }
      const result = await this.orchestrationMutations.run(
        request,
        effectiveParams,
        invoke,
        legacyCoordinator?.mutationCallerFingerprint ?? authenticatedCallerFingerprint
      )
      recordRuntimeFeatureInteraction(
        this.runtime,
        request.method,
        result,
        undefined,
        request.params
      )
      return successResponse(request.id, meta, result)
    } catch (error) {
      if (request.method.startsWith('emulator.')) {
        emulatorProbeError(`rpc ${request.method}`, error, { params: request.params })
      }
      return mapDispatcherError(request, meta, error)
    }
  }

  async dispatchStreaming(
    request: RpcRequest,
    reply: (response: string) => void,
    options?: RpcDispatchStreamingOptions
  ): Promise<void> {
    return this.streamingDispatcher.dispatch(request, reply, options)
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
