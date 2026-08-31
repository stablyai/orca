import {
  buildRegistry,
  isStreamingMethod,
  type RpcAnyMethod,
  type RpcEnvelopeMeta,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse
} from './core'

import { errorResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  getOrchestrationMutationExecutor,
  type OrchestrationMutationExecutor
} from './orchestration-mutation-executor'
import { orchestrationMigrationFence } from './orchestration-contract-fence'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import { createDispatcherStreamingFeatureEmitter } from './dispatcher-streaming-feature-emitter'
import { executeUnaryRpc, type UnaryRpcExecutionDeps } from './dispatcher-unary-execution'

export type DispatcherOptions = { runtime: OrcaRuntimeService; methods?: readonly RpcAnyMethod[] }

// oxfmt-ignore
type DispatchCallOptions = Pick<RpcDispatchStreamingOptions, 'signal' | 'connectionId' | 'clientId' | 'clientKind' | 'clientCapabilities' | 'authenticatedCallerFingerprint'>

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

    return executeUnaryRpc(this.unaryDeps(), request, method, parsedParams.value, meta, options)
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

    const parsedParams = parseRpcRequestParams(request, method, meta)
    if (parsedParams.error) {
      reply(JSON.stringify(parsedParams.error))
      return
    }

    if (!isStreamingMethod(method)) {
      const response = await executeUnaryRpc(
        this.unaryDeps(),
        request,
        method,
        parsedParams.value,
        meta,
        options
      )
      reply(JSON.stringify(response))
      return
    }

    const { emit, recordedFeatureInteractions } = createDispatcherStreamingFeatureEmitter(
      this.runtime,
      request,
      meta,
      reply
    )

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
          registerBinaryStreamHandler: options?.registerBinaryStreamHandler,
          registerBinaryMessageHandler: options?.registerBinaryMessageHandler
        },
        emit
      )
      recordRuntimeFeatureInteraction(
        this.runtime,
        request.method,
        result,
        recordedFeatureInteractions,
        request.params
      )
    } catch (error) {
      reply(JSON.stringify(mapDispatcherError(request, meta, error)))
    }
  }

  private unaryDeps(): UnaryRpcExecutionDeps {
    return {
      runtime: this.runtime,
      orchestrationMutations: this.orchestrationMutations,
      legacyOrchestration: this.legacyOrchestration
    }
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
