import {
  buildRegistry,
  formatZodError,
  isStreamingMethod,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse
} from './core'

import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import { errorResponse, successResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  authenticatedCallerFingerprint,
  getOrchestrationMutationExecutor,
  type OrchestrationMutationExecutor,
  type DurableMutationInvocation
} from './orchestration-mutation-executor'
import { orchestrationMigrationFence } from './orchestration-contract-fence'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { invalidArgumentResponse, mapDispatcherError } from './dispatcher-error-response'

export type DispatcherOptions = { runtime: OrcaRuntimeService; methods?: readonly RpcAnyMethod[] }

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry
  private readonly orchestrationMutations: OrchestrationMutationExecutor
  private readonly legacyOrchestration: OrchestrationLegacyCompatibility

  constructor({ runtime, methods = ALL_RPC_METHODS }: DispatcherOptions) {
    this.runtime = runtime
    this.registry = buildRegistry(methods)
    this.orchestrationMutations = getOrchestrationMutationExecutor(runtime)
    this.legacyOrchestration = new OrchestrationLegacyCompatibility(runtime)
  }

  async dispatch(request: RpcRequest, options?: { signal?: AbortSignal }): Promise<RpcResponse> {
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

    const parsedParams = this.parseParams(request, method, meta)
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
      const invoke = (mutation?: DurableMutationInvocation) => {
        const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
        return method.handler(effectiveParams, {
          runtime: this.runtime,
          signal: options?.signal,
          requestId: request.id,
          orchestrationCapability: request.orchestrationCapability,
          authenticatedCallerFingerprint:
            mutation?.identity.callerFingerprint ?? authenticatedCallerFingerprint(request),
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
        legacyCoordinator?.mutationCallerFingerprint
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

  // Why: streaming dispatch sends multiple responses through the reply callback
  // instead of returning a single Promise. This enables terminal.subscribe and
  // other subscription-style methods that push data over time.
  async dispatchStreaming(
    request: RpcRequest,
    reply: (response: string) => void,
    options?: RpcDispatchStreamingOptions
  ): Promise<void> {
    const meta = this.meta()
    const method = this.registry.get(request.method)
    if (!method) {
      reply(
        JSON.stringify(
          errorResponse(request.id, meta, 'method_not_found', `Unknown method: ${request.method}`)
        )
      )
      return
    }

    const migrationFence = orchestrationMigrationFence(request, meta)
    if (migrationFence) {
      reply(JSON.stringify(migrationFence))
      return
    }

    const parsedParams = this.parseParams(request, method, meta)
    if (parsedParams.error) {
      reply(JSON.stringify(parsedParams.error))
      return
    }

    if (!isStreamingMethod(method)) {
      try {
        const compatibility = await this.legacyOrchestration.tryHandle(
          request,
          parsedParams.value,
          options?.signal
        )
        if (compatibility.handled) {
          reply(JSON.stringify(successResponse(request.id, meta, compatibility.result)))
          return
        }
        const effectiveParams = compatibility.params ?? parsedParams.value
        const legacyCoordinator = this.legacyOrchestration.createCoordinatorInvocation(
          request,
          compatibility.legacyCoordinatorAuthority
        )
        const invoke = (mutation?: DurableMutationInvocation) => {
          const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
          return method.handler(effectiveParams, {
            runtime: this.runtime,
            signal: options?.signal,
            requestId: request.id,
            connectionId: options?.connectionId,
            clientId: options?.clientId,
            pairedDeviceId: options?.pairedDeviceId,
            clientKind: options?.clientKind,
            clientCapabilities: options?.clientCapabilities,
            orchestrationCapability: request.orchestrationCapability,
            authenticatedCallerFingerprint:
              mutation?.identity.callerFingerprint ?? authenticatedCallerFingerprint(request),
            recordMutationReceipt: mutation?.recordReceipt,
            orchestrationMutation: mutation?.identity,
            pairing: options?.pairing,
            sendBinary: options?.sendBinary,
            registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
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
          legacyCoordinator?.mutationCallerFingerprint
        )
        recordRuntimeFeatureInteraction(
          this.runtime,
          request.method,
          result,
          undefined,
          request.params
        )
        reply(JSON.stringify(successResponse(request.id, meta, result)))
      } catch (error) {
        reply(JSON.stringify(mapDispatcherError(request, meta, error)))
      }
      return
    }

    const recordedStreamingFeatureInteractions = new Set<FeatureInteractionId>()
    const emit = (result: unknown): void => {
      recordRuntimeFeatureInteraction(
        this.runtime,
        request.method,
        result,
        recordedStreamingFeatureInteractions,
        request.params
      )
      const response = successResponse(request.id, meta, result)
      response.streaming = true
      reply(JSON.stringify(response))
    }

    try {
      const result = await method.handler(
        parsedParams.value,
        {
          runtime: this.runtime,
          signal: options?.signal,
          requestId: request.id,
          connectionId: options?.connectionId,
          clientId: options?.clientId,
          pairedDeviceId: options?.pairedDeviceId,
          clientKind: options?.clientKind,
          clientCapabilities: options?.clientCapabilities,
          orchestrationCapability: request.orchestrationCapability,
          pairing: options?.pairing,
          sendBinary: options?.sendBinary,
          registerBinaryStreamHandler: options?.registerBinaryStreamHandler
        },
        emit
      )
      recordRuntimeFeatureInteraction(
        this.runtime,
        request.method,
        result,
        recordedStreamingFeatureInteractions,
        request.params
      )
    } catch (error) {
      reply(JSON.stringify(mapDispatcherError(request, meta, error)))
    }
  }

  private parseParams(
    request: RpcRequest,
    method: RpcAnyMethod,
    meta: RpcEnvelopeMeta
  ): { value: unknown; error?: undefined } | { value?: undefined; error: RpcResponse } {
    if (method.params === null) {
      return { value: undefined }
    }
    const rawParams = request.params ?? {}
    const result = method.params.safeParse(rawParams)
    if (!result.success) {
      return {
        error: invalidArgumentResponse(request, meta, formatZodError(result.error))
      }
    }
    return { value: result.data }
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
