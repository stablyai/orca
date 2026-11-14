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

import { successResponse } from './responses/rpc-response'
import { withoutMethodsThisHostDoesNotServe } from './methods/terminal/session-terminal-scrollback'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import { isDurableMutation } from '../../../shared/orchestration/orchestration-rpc-contract'
import type { OrchestrationEntryCaller } from '../orchestration/addressing/orchestration-caller-identity'
import {
  getOrchestrationMutationExecutor,
  type DurableMutationInvocation,
  type OrchestrationMutationExecutor
} from './orchestration/mutations/orchestration-mutation-executor'
import { OrchestrationLegacyCompatibility } from './orchestration/compatibility/orchestration-legacy-compatibility'
import {
  rpcContextFromTransport,
  type RpcDispatchStreamingOptions
} from './dispatch/dispatcher-stream-options'
import { mapDispatcherError } from './responses/dispatcher-error-response'
import { createDispatcherStreamingFeatureEmitter } from './dispatch/dispatcher-streaming-feature-emitter'
import { recordRuntimeFeatureInteraction } from './dispatch/runtime-feature-interaction'
import type { RpcCallerScope } from './callers/rpc-caller-scope'
import { runWithActiveRpcCaller } from './callers/active-call'
import { admitRpcRequest } from './dispatch/rpc-request-admission-prologue'
import { resolveOrcadFeatureRequirement, rpcMethodFeatureWait } from './startup/orcad-readiness'
import { routeRemoteOwnedCall } from '../orchestration/federation/remote-owned/remote-owned-route'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods: readonly RpcAnyMethodDeclaration[]
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
  private readonly registry: RpcRegistry
  private readonly orchestrationMutations: OrchestrationMutationExecutor
  private readonly legacyOrchestration: OrchestrationLegacyCompatibility
  private readonly pinnedCallerScope: RpcCallerScope | undefined

  constructor({ runtime, methods, callerScope }: DispatcherOptions) {
    this.runtime = runtime
    this.pinnedCallerScope = callerScope
    this.registry = buildRegistry(withoutMethodsThisHostDoesNotServe(methods))
    this.orchestrationMutations = getOrchestrationMutationExecutor(runtime)
    this.legacyOrchestration = new OrchestrationLegacyCompatibility(runtime)
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
        rpcContextFromTransport(this.runtime, request, options, caller, params),
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
    return admitRpcRequest(
      {
        runtime: this.runtime,
        registry: this.registry,
        meta,
        pinnedCallerScope: this.pinnedCallerScope
      },
      request,
      options,
      isTransportSupported
    )
  }

  private async invokeUnary(
    { request, method, params, caller }: AdmittedUnaryCall,
    options: RpcDispatchStreamingOptions | undefined
  ): Promise<unknown> {
    const { runtime, orchestrationMutations, legacyOrchestration } = this
    const context = rpcContextFromTransport(runtime, request, options, caller, params)
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

    // A paired Orca is never a legacy caller, so its calls reach only the declared access check.
    const compatibility =
      caller?.kind === 'peer'
        ? { handled: false as const }
        : await legacyOrchestration.tryHandle(request, params, context.signal)
    if (compatibility.handled) {
      return compatibility.result
    }
    const effectiveParams = compatibility.params ?? params
    const legacyCoordinator = legacyOrchestration.createCoordinatorInvocation(
      request,
      compatibility.legacyCoordinatorAuthority
    )
    // Before this Orca's receipts: the server that owns the worker keeps the receipt, under the caller's scoped key.
    const remote = await routeRemoteOwnedCall(runtime, method, request, effectiveParams, {
      ...context,
      orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
    })
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
    // A legacy coordinator fingerprint outranks the transport identity; mint a fallback only when absent.
    const fallbackCallerFingerprint =
      context.authenticatedCallerFingerprint ??
      (!legacyCoordinator &&
      (request.method.startsWith('orchestration.federation') ||
        (!!request.orchestrationRequestId && isDurableMutation(request.method, effectiveParams)))
        ? orchestrationMutations.getLocalAuthenticatedCallerFingerprint()
        : undefined)
    const callerFingerprint =
      legacyCoordinator?.mutationCallerFingerprint ?? fallbackCallerFingerprint
    const invoke = (mutation?: DurableMutationInvocation) => {
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
        request.orchestrationCompatibilityEvidence?.agentSessionId
      )
    }
    const result = await orchestrationMutations.run(
      request,
      effectiveParams,
      invoke,
      callerFingerprint,
      context.orchestrationCaller
    )
    if (request.method.startsWith('orchestration.')) {
      queueMicrotask(() => {
        try {
          runtime.refreshAgentSenderAssociations?.()
        } catch (error) {
          console.warn('[runtime] Sender identity publication failed', error)
        }
      })
    }
    recordRuntimeFeatureInteraction(runtime, request.method, result, undefined, request.params)
    return result
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
