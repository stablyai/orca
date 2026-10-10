import {
  buildRegistry,
  isStreamingMethod,
  type RpcAnyMethodDeclaration,
  type RpcEnvelopeMeta,
  type RpcMethod,
  type RpcRegistry,
  type RpcRequest,
  type RpcResponse,
  type RpcStreamingMethod
} from './core'

import { successResponse, errorResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  getOrchestrationMutationExecutor,
  type OrchestrationMutationExecutor
} from './orchestration-mutation-executor'
import { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import {
  rpcContextFromTransport,
  type RpcDispatchStreamingOptions
} from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { RpcStreamingDispatcher } from './rpc-streaming-dispatcher'
import { invokeDispatcherUnaryMethod } from './dispatcher-unary-method-invocation'
import type { RpcCallerScope } from './rpc-caller-scope'
import { admitRpcRequest } from './rpc-request-admission-prologue'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods?: readonly RpcAnyMethodDeclaration[]
  /** Pins every call to this scope, for in-process bridges that relay a non-owner caller. */
  callerScope?: RpcCallerScope
}

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry
  private readonly orchestrationMutations: OrchestrationMutationExecutor
  private readonly legacyOrchestration: OrchestrationLegacyCompatibility
  private readonly streamingDispatcher: RpcStreamingDispatcher
  private readonly pinnedCallerScope: RpcCallerScope | undefined

  constructor({ runtime, methods = ALL_RPC_METHODS, callerScope }: DispatcherOptions) {
    this.runtime = runtime
    this.pinnedCallerScope = callerScope
    this.registry = buildRegistry(methods)
    this.orchestrationMutations = getOrchestrationMutationExecutor(runtime)
    this.legacyOrchestration = new OrchestrationLegacyCompatibility(runtime)
    this.streamingDispatcher = new RpcStreamingDispatcher({
      runtime,
      registry: this.registry,
      orchestrationMutations: this.orchestrationMutations,
      legacyOrchestration: this.legacyOrchestration,
      meta: () => this.meta(),
      pinnedCallerScope: callerScope
    })
  }

  async dispatch(request: RpcRequest, options?: RpcDispatchStreamingOptions): Promise<RpcResponse> {
    const meta = this.meta()
    const pendingAdmission = admitRpcRequest(
      {
        runtime: this.runtime,
        registry: this.registry,
        meta,
        pinnedCallerScope: this.pinnedCallerScope
      },
      request,
      options,
      (method: RpcMethod | RpcStreamingMethod): method is RpcMethod => !isStreamingMethod(method)
    )
    const admission =
      pendingAdmission instanceof Promise ? await pendingAdmission : pendingAdmission
    if ('rejected' in admission) {
      return admission.rejected
    }

    if (request.method.startsWith('emulator.')) {
      emulatorProbe(`rpc ${request.method}`, request.params)
    }
    try {
      const result = await invokeDispatcherUnaryMethod({
        runtime: this.runtime,
        request: admission.request,
        method: admission.method,
        params: admission.params,
        context: rpcContextFromTransport(
          this.runtime,
          admission.request,
          options,
          admission.caller
        ),
        orchestrationMutations: this.orchestrationMutations,
        legacyOrchestration: this.legacyOrchestration
      })
      const filtered = admission.binding?.filterResult?.(result) ?? {
        kind: 'allowed',
        result
      }
      if (filtered.kind === 'denied') {
        return errorResponse(request.id, meta, 'forbidden', filtered.message)
      }
      return successResponse(request.id, meta, filtered.result)
    } catch (error) {
      if (request.method.startsWith('emulator.')) {
        emulatorProbeError(`rpc ${request.method}`, error, {
          params: request.params
        })
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
