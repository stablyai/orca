import {
  isStreamingMethod,
  type RpcEnvelopeMeta,
  type RpcMethod,
  type RpcRegistry,
  type RpcRequest,
  type RpcStreamingMethod
} from './core'

import { errorResponse, successResponse } from './errors'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationMutationExecutor } from './orchestration-mutation-executor'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import type { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import {
  rpcContextFromTransport,
  type RpcDispatchStreamingOptions
} from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { createDispatcherStreamingFeatureEmitter } from './dispatcher-streaming-feature-emitter'
import { invokeDispatcherUnaryMethod } from './dispatcher-unary-method-invocation'
import type { RpcCallerScope } from './rpc-caller-scope'
import { admitRpcRequest } from './rpc-request-admission-prologue'

export type RpcStreamingDispatcherDependencies = {
  runtime: OrcaRuntimeService
  registry: RpcRegistry
  orchestrationMutations: OrchestrationMutationExecutor
  legacyOrchestration: OrchestrationLegacyCompatibility
  meta: () => RpcEnvelopeMeta
  pinnedCallerScope?: RpcCallerScope
}

export class RpcStreamingDispatcher {
  constructor(private readonly dependencies: RpcStreamingDispatcherDependencies) {}

  // Why: streaming dispatch sends multiple responses through the reply callback instead of a Promise.
  async dispatch(
    rawRequest: RpcRequest,
    reply: (response: string) => void,
    options?: RpcDispatchStreamingOptions
  ): Promise<void> {
    const { runtime, registry, orchestrationMutations, legacyOrchestration, meta } =
      this.dependencies
    const envelopeMeta = meta()
    const pendingAdmission = admitRpcRequest(
      {
        runtime,
        registry,
        meta: envelopeMeta,
        pinnedCallerScope: this.dependencies.pinnedCallerScope
      },
      rawRequest,
      options,
      (_method: RpcMethod | RpcStreamingMethod): _method is RpcMethod | RpcStreamingMethod => true
    )
    const admission =
      pendingAdmission instanceof Promise ? await pendingAdmission : pendingAdmission
    if ('rejected' in admission) {
      reply(JSON.stringify(admission.rejected))
      return
    }
    const { method, request, params, binding, caller } = admission

    if (!isStreamingMethod(method)) {
      try {
        const result = await invokeDispatcherUnaryMethod({
          runtime,
          request,
          method,
          params,
          context: rpcContextFromTransport(runtime, request, options, caller),
          orchestrationMutations,
          legacyOrchestration
        })
        const filtered = binding?.filterResult?.(result) ?? {
          kind: 'allowed',
          result
        }
        reply(
          JSON.stringify(
            filtered.kind === 'denied'
              ? errorResponse(request.id, envelopeMeta, 'forbidden', filtered.message)
              : successResponse(request.id, envelopeMeta, filtered.result)
          )
        )
      } catch (error) {
        reply(JSON.stringify(mapDispatcherError(request, envelopeMeta, error)))
      }
      return
    }

    const { emit, recordedFeatureInteractions } = createDispatcherStreamingFeatureEmitter(
      runtime,
      request,
      envelopeMeta,
      reply
    )

    try {
      const result = await method.handler(
        params,
        rpcContextFromTransport(runtime, request, options, caller),
        emit
      )
      recordRuntimeFeatureInteraction(
        runtime,
        request.method,
        result,
        recordedFeatureInteractions,
        request.params
      )
    } catch (error) {
      reply(JSON.stringify(mapDispatcherError(request, envelopeMeta, error)))
    }
  }
}
