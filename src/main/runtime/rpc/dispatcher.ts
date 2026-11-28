import {
  isStreamingMethod,
  type RpcAnyMethodDeclaration,
  type RpcEnvelopeMeta,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type RpcStreamingMethod
} from './core'
import { guardedRpcCallContext, rpcCallContext } from './rpc-call-context'
import { successResponse } from './responses/rpc-response'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationEntryCaller } from '../orchestration/addressing/orchestration-caller-identity'
import { OrchestrationDispatchRouting } from './orchestration/orchestration-dispatch-routing'
import type { RpcDispatchStreamingOptions } from './dispatch/dispatcher-stream-options'
import { mapDispatcherError } from './responses/dispatcher-error-response'
import { createDispatcherStreamingFeatureEmitter } from './dispatch/dispatcher-streaming-feature-emitter'
import { recordRuntimeFeatureInteraction } from './dispatch/runtime-feature-interaction'
import type { RpcCallerScope } from './callers/rpc-caller-scope'
import { runWithActiveRpcCaller } from './callers/active-call'
import { admitRpcRequest } from './dispatch/rpc-request-admission-prologue'
import { resolveOrcadFeatureRequirement, rpcMethodFeatureWait } from './startup/orcad-readiness'
import { LazyRpcMethodLoader, type LazyRpcMethodGroup } from './lazy-rpc-method-group'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods: readonly RpcAnyMethodDeclaration[]
  /** Optional lazy method groups loaded on first dispatch of a matching method name. */
  lazyGroups?: readonly LazyRpcMethodGroup[]
  /** Pins every call to this scope, for in-process bridges that relay a non-owner caller. */
  callerScope?: RpcCallerScope
}

type AdmittedUnaryCall = {
  request: RpcRequest
  method: RpcMethod
  params: unknown
  caller: OrchestrationEntryCaller | undefined
}

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly lazyLoader: LazyRpcMethodLoader
  private readonly orchestrationRouting: OrchestrationDispatchRouting
  private readonly pinnedCallerScope: RpcCallerScope | undefined

  constructor({ runtime, methods, lazyGroups = [], callerScope }: DispatcherOptions) {
    this.runtime = runtime
    this.pinnedCallerScope = callerScope
    this.lazyLoader = new LazyRpcMethodLoader(methods, lazyGroups)
    this.orchestrationRouting = new OrchestrationDispatchRouting(runtime)
  }

  /** Loads the lazy group serving `methodName`, if any, so a caller can recheck state before dispatching. */
  async ensureMethodLoaded(methodName: string): Promise<void> {
    await this.lazyLoader.ensureMethodLoaded(methodName)
  }

  async dispatch(request: RpcRequest, options?: RpcDispatchStreamingOptions): Promise<RpcResponse> {
    const meta = this.meta()
    const pendingAdmission = this.admit(
      request,
      options,
      meta,
      (method: RpcMethod | RpcStreamingMethod): method is RpcMethod => !isStreamingMethod(method)
    )
    const admission =
      pendingAdmission instanceof Promise ? await pendingAdmission : pendingAdmission
    if ('rejected' in admission) {
      return admission.rejected
    }

    // Only request/response dispatch probes emulator calls; streaming-unary retains its existing behavior.
    const probeEmulator = request.method.startsWith('emulator.')
    if (probeEmulator) {
      emulatorProbe(`rpc ${request.method}`, request.params)
    }
    try {
      const featureWait = rpcMethodFeatureWait(
        resolveOrcadFeatureRequirement(admission.method.requires, admission.params),
        [options?.signal, options?.connectionSignal]
      )
      if (featureWait) {
        await featureWait
      }
      options?.beforeInvoke?.()
      return successResponse(request.id, meta, await this.invokeUnary(admission, options))
    } catch (error) {
      options?.onHandlerError?.(error)
      if (probeEmulator) {
        emulatorProbeError(`rpc ${request.method}`, error, {
          params: request.params
        })
      }
      return mapDispatcherError(request, meta, error)
    }
  }

  async dispatchStreaming(
    rawRequest: RpcRequest,
    reply: (response: string) => void,
    options?: RpcDispatchStreamingOptions
  ): Promise<void> {
    return this.dispatchStreamingObjects(
      rawRequest,
      (response) => reply(JSON.stringify(response)),
      options
    )
  }

  // Transport callbacks must clone or encode synchronously before runtime-owned values change.
  async dispatchStreamingObjects(
    rawRequest: RpcRequest,
    reply: (response: RpcResponse) => void,
    options?: RpcDispatchStreamingOptions
  ): Promise<void> {
    const meta = this.meta()
    const pendingAdmission = this.admit(
      rawRequest,
      options,
      meta,
      (_method: RpcMethod | RpcStreamingMethod): _method is RpcMethod | RpcStreamingMethod => true
    )
    const admission =
      pendingAdmission instanceof Promise ? await pendingAdmission : pendingAdmission
    if ('rejected' in admission) {
      reply(admission.rejected)
      return
    }
    const { method, request, params, caller } = admission
    const featureWait = rpcMethodFeatureWait(
      resolveOrcadFeatureRequirement(method.requires, params),
      [options?.signal, options?.connectionSignal]
    )
    if (featureWait) {
      try {
        await featureWait
      } catch (error) {
        reply(mapDispatcherError(request, meta, error))
        return
      }
    }

    if (!isStreamingMethod(method)) {
      try {
        const result = await this.invokeUnary({ method, request, params, caller }, options)
        reply(successResponse(request.id, meta, result))
      } catch (error) {
        reply(mapDispatcherError(request, meta, error))
      }
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
        params,
        rpcCallContext(this.runtime, request, options, this.pinnedCallerScope, caller, params),
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
      reply(mapDispatcherError(request, meta, error))
    }
  }

  private admit<M extends RpcMethod | RpcStreamingMethod>(
    request: RpcRequest,
    options: RpcDispatchStreamingOptions | undefined,
    meta: RpcEnvelopeMeta,
    isTransportSupported: (method: RpcMethod | RpcStreamingMethod) => method is M
  ) {
    const loadPending = this.lazyLoader.ensureMethodLoaded(request.method)
    const runAdmit = () =>
      admitRpcRequest(
        {
          runtime: this.runtime,
          registry: this.lazyLoader.registry,
          meta,
          pinnedCallerScope: this.pinnedCallerScope
        },
        request,
        options,
        isTransportSupported
      )
    return loadPending ? loadPending.then(runAdmit) : runAdmit()
  }

  private async invokeUnary(
    { request, method, params, caller }: AdmittedUnaryCall,
    options: RpcDispatchStreamingOptions | undefined
  ): Promise<unknown> {
    const { runtime, pinnedCallerScope: scope } = this
    const context = guardedRpcCallContext(runtime, request, options, scope, caller, params)
    // Runtime test fakes may omit client-hosted browser routing.
    const clientHostedBrowser = await (runtime.routeClientHostedBrowserRpc?.(
      request.method,
      params,
      context.caller
    ) ?? { handled: false as const })
    if (clientHostedBrowser.handled) {
      recordRuntimeFeatureInteraction(
        runtime,
        request.method,
        clientHostedBrowser.result,
        undefined,
        request.params
      )
      return clientHostedBrowser.result
    }
    const desktopBrowser = await (runtime.routeDesktopBrowserBridgeRpc?.(
      request.method,
      params,
      context
    ) ?? { handled: false as const })
    if (desktopBrowser.handled) {
      return desktopBrowser.result
    }

    const { compatibility, legacyCoordinator } = await this.orchestrationRouting.resolveLegacy(
      request,
      params,
      caller,
      context.signal
    )
    if (compatibility.handled) {
      return compatibility.result
    }
    const effectiveParams = compatibility.params ?? params
    // Before this Orca's receipts: the server that owns the worker keeps the receipt, under the caller's scoped key.
    const remote = await this.orchestrationRouting.routeRemoteOwned(
      method,
      request,
      effectiveParams,
      context
    )
    if (remote.handled) {
      recordRuntimeFeatureInteraction(
        runtime,
        request.method,
        remote.result,
        undefined,
        request.params
      )
      return remote.result
    }
    const result = await this.orchestrationRouting.runWithMutationReceipt(
      request,
      effectiveParams,
      context,
      legacyCoordinator,
      (callerFingerprint, mutation) => {
        const legacyCoordinatorRunId = legacyCoordinator?.revalidate()
        return runWithActiveRpcCaller(
          context.caller,
          () =>
            method.handler(effectiveParams, {
              ...context,
              authenticatedCallerFingerprint:
                mutation?.identity.callerFingerprint ?? callerFingerprint,
              recordMutationReceipt: mutation?.recordReceipt,
              markWorkerDoneMutationEffectFree: mutation?.markWorkerDoneEffectFree,
              markMutationEffectPossible: mutation?.markEffectPossible,
              orchestrationMutation: mutation?.identity,
              replayedMutationReceipt: mutation?.replayedReceipt,
              legacyCoordinatorRunId,
              legacyCoordinatorAuthority: legacyCoordinator?.authority,
              revalidateLegacyCoordinator: legacyCoordinator?.revalidate,
              orchestrationCompatibilityCallerAuthority:
                compatibility.orchestrationCompatibilityCallerAuthority,
              orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
            }),
          request.orchestrationCompatibilityEvidence?.agentSessionId,
          context.deviceSelf?.clientInstanceId()
        )
      }
    )
    if (request.method.startsWith('orchestration.')) {
      queueMicrotask(() => {
        void runtime.refreshAgentSenderAssociations?.().catch((error) => {
          console.warn('[runtime] Sender identity publication failed', error)
        })
      })
    }
    recordRuntimeFeatureInteraction(runtime, request.method, result, undefined, request.params)
    return result
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
