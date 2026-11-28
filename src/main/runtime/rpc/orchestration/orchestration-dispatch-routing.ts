import { isDurableMutation } from '../../../../shared/orchestration/orchestration-rpc-contract'
import { ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext, RpcMethod, RpcRequest } from '../core'
import type {
  DurableMutationInvocation,
  OrchestrationMutationExecutor
} from './mutations/orchestration-mutation-executor'
import type {
  LegacyCompatibilityRoute,
  LegacyCoordinatorInvocation,
  OrchestrationLegacyCompatibility
} from './compatibility/orchestration-legacy-compatibility'

type RemoteOwnedRouteResult = { handled: false } | { handled: true; result: unknown }

/** Lazy-loads orchestration compatibility, remote-owned forwarding, and durable mutation tracking on first use. */
export class OrchestrationDispatchRouting {
  private mutationsPromise: Promise<OrchestrationMutationExecutor> | null = null
  private legacyPromise: Promise<OrchestrationLegacyCompatibility> | null = null

  constructor(private readonly runtime: OrcaRuntimeService) {}

  async resolveLegacy(
    request: RpcRequest,
    params: unknown,
    caller: OrchestrationEntryCaller | undefined,
    signal: AbortSignal | undefined
  ): Promise<{
    compatibility: LegacyCompatibilityRoute
    legacyCoordinator: LegacyCoordinatorInvocation | undefined
  }> {
    if (caller?.kind === 'peer' || !request.method.startsWith('orchestration.')) {
      return { compatibility: { handled: false }, legacyCoordinator: undefined }
    }
    const legacy = await this.getLegacyOrchestration()
    const compatibility = await legacy.tryHandle(request, params, signal)
    if (compatibility.handled) {
      return { compatibility, legacyCoordinator: undefined }
    }
    return {
      compatibility,
      legacyCoordinator: legacy.createCoordinatorInvocation(
        request,
        compatibility.legacyCoordinatorAuthority
      )
    }
  }

  async routeRemoteOwned(
    method: RpcMethod,
    request: RpcRequest,
    params: unknown,
    context: RpcContext
  ): Promise<RemoteOwnedRouteResult> {
    const access = method.orchestrationAccess
    if (!access || access.kind === 'localOnly' || context.orchestrationCaller?.kind === 'peer') {
      return { handled: false }
    }
    const { routeRemoteOwnedCall } =
      await import('../../orchestration/federation/remote-owned/remote-owned-route')
    return routeRemoteOwnedCall(this.runtime, method, request, params, {
      ...context,
      orchestrationCompatibilityEvidence: request.orchestrationCompatibilityEvidence
    })
  }

  async runWithMutationReceipt(
    request: RpcRequest,
    effectiveParams: unknown,
    context: RpcContext,
    legacyCoordinator: LegacyCoordinatorInvocation | undefined,
    invoke: (callerFingerprint: string | undefined, mutation?: DurableMutationInvocation) => unknown
  ): Promise<unknown> {
    const durableMutation =
      !!request.orchestrationRequestId && isDurableMutation(request.method, effectiveParams)
    const needsMutationExecutor =
      durableMutation ||
      request.orchestrationContractVersion === ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
    const needsFallbackCallerFingerprint =
      !context.authenticatedCallerFingerprint &&
      !legacyCoordinator &&
      (request.method.startsWith('orchestration.federation') || durableMutation)
    const mutations =
      needsMutationExecutor || needsFallbackCallerFingerprint
        ? await this.getOrchestrationMutations()
        : null
    const fallbackCallerFingerprint =
      context.authenticatedCallerFingerprint ??
      (needsFallbackCallerFingerprint
        ? mutations!.getLocalAuthenticatedCallerFingerprint()
        : undefined)
    const callerFingerprint =
      legacyCoordinator?.mutationCallerFingerprint ?? fallbackCallerFingerprint
    if (!needsMutationExecutor || !mutations) {
      return await invoke(callerFingerprint)
    }
    return await mutations.run(
      request,
      effectiveParams,
      (mutation) => invoke(callerFingerprint, mutation),
      callerFingerprint,
      context.orchestrationCaller
    )
  }

  private getOrchestrationMutations(): Promise<OrchestrationMutationExecutor> {
    if (!this.mutationsPromise) {
      this.mutationsPromise = import('./mutations/orchestration-mutation-executor')
        .then(({ getOrchestrationMutationExecutor }) =>
          getOrchestrationMutationExecutor(this.runtime)
        )
        .catch((error) => {
          this.mutationsPromise = null
          throw error
        })
    }
    return this.mutationsPromise
  }

  private getLegacyOrchestration(): Promise<OrchestrationLegacyCompatibility> {
    if (!this.legacyPromise) {
      this.legacyPromise = import('./compatibility/orchestration-legacy-compatibility')
        .then(({ OrchestrationLegacyCompatibility }) => {
          return new OrchestrationLegacyCompatibility(this.runtime)
        })
        .catch((error) => {
          this.legacyPromise = null
          throw error
        })
    }
    return this.legacyPromise
  }
}
