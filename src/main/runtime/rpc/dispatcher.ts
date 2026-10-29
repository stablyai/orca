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

import { successResponse } from './errors'
import { ALL_RPC_METHODS } from './methods'
import { withoutMethodsThisHostDoesNotServe } from './methods/session-terminal-scrollback'
import { emulatorProbe, emulatorProbeError } from '../../emulator/emulator-probe'
import type { OrcaRuntimeService } from '../orca-runtime'
import { isDurableMutation } from '../../../shared/orchestration-rpc-contract'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import {
  getOrchestrationMutationExecutor,
  type DurableMutationInvocation,
  type OrchestrationMutationExecutor
} from './orchestration-mutation-executor'
import { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import {
  rpcContextFromTransport,
  type RpcDispatchStreamingOptions
} from './dispatcher-stream-options'
import { mapDispatcherError } from './dispatcher-error-response'
import { createDispatcherStreamingFeatureEmitter } from './dispatcher-streaming-feature-emitter'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'
import type { RpcCallerScope } from './rpc-caller-scope'
import { runWithActiveRpcCaller } from './rpc-active-caller'
import { admitRpcRequest } from './rpc-request-admission-prologue'
import { resolveOrcadFeatureRequirement, rpcMethodFeatureWait } from './orcad-feature-readiness'

export type DispatcherOptions = {
  runtime: OrcaRuntimeService
  methods?: readonly RpcAnyMethodDeclaration[]
  /** Pins every call to this scope, for in-process bridges that relay a non-owner caller. */
  callerScope?: RpcCallerScope
}

type AdmittedUnaryCall = {
  request: RpcRequest
  method: RpcMethod
  params: unknown
  caller: OrchestrationSessionCaller | undefined
}

export class RpcDispatcher {
  private readonly runtime: OrcaRuntimeService
  private readonly registry: RpcRegistry
  private readonly orchestrationMutations: OrchestrationMutationExecutor
  private readonly legacyOrchestration: OrchestrationLegacyCompatibility
  private readonly pinnedCallerScope: RpcCallerScope | undefined

  constructor({ runtime, methods = ALL_RPC_METHODS, callerScope }: DispatcherOptions) {
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
      return successResponse(request.id, meta, await this.invokeUnary(admission, options))
    } catch (error) {
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
      reply(JSON.stringify(admission.rejected))
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
        reply(JSON.stringify(mapDispatcherError(request, meta, error)))
        return
      }
    }

    if (!isStreamingMethod(method)) {
      try {
        const result = await this.invokeUnary({ method, request, params, caller }, options)
        reply(JSON.stringify(successResponse(request.id, meta, result)))
      } catch (error) {
        reply(JSON.stringify(mapDispatcherError(request, meta, error)))
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
        rpcContextFromTransport(this.runtime, request, options, caller),
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
    const context = rpcContextFromTransport(runtime, request, options, caller)
    // Runtime test fakes may omit client-hosted browser routing.
    const clientHostedBrowser = await (runtime.routeClientHostedBrowserRpc?.(
      request.method,
      params
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

    const compatibility = await legacyOrchestration.tryHandle(request, params, context.signal)
    if (compatibility.handled) {
      return compatibility.result
    }
    const effectiveParams = compatibility.params ?? params
    const legacyCoordinator = legacyOrchestration.createCoordinatorInvocation(
      request,
      compatibility.legacyCoordinatorAuthority
    )
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
      return runWithActiveRpcCaller(context.caller, () =>
        method.handler(effectiveParams, {
          ...context,
          authenticatedCallerFingerprint: mutation?.identity.callerFingerprint ?? callerFingerprint,
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
        })
      )
    }
    const result = await orchestrationMutations.run(
      request,
      effectiveParams,
      invoke,
      callerFingerprint,
      context.orchestrationCaller?.orcaSessionId
    )
    recordRuntimeFeatureInteraction(runtime, request.method, result, undefined, request.params)
    return result
  }

  private meta(): RpcEnvelopeMeta {
    return { runtimeId: this.runtime.getRuntimeId() }
  }
}
