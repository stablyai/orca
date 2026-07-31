import { createHash } from 'node:crypto'
import type { LegacyCoordinatorAuthorityProof, RpcRequest } from './core'
import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import { LegacyCompatibilityAuthority } from './orchestration-legacy-authority'
import { handleLegacyLifecycleSend } from './orchestration-legacy-lifecycle'
import { handleLegacyCheck, handleLegacyReply } from './orchestration-legacy-mail'
import { handleLegacyAsk } from './orchestration-legacy-question'
import type {
  LegacyAskParams,
  LegacyCheckParams,
  LegacyReplyParams,
  LegacySendParams
} from './orchestration-legacy-operation'
import { LegacyCoordinatorAuthority } from './orchestration-legacy-coordinator-authority'

const COORDINATOR_PREFLIGHT_METHODS = new Set([
  'orchestration.taskCreate',
  'orchestration.taskList',
  'orchestration.taskUpdate',
  'orchestration.dispatch',
  'orchestration.gateCreate',
  'orchestration.gateResolve',
  'orchestration.runUse',
  'orchestration.send',
  'orchestration.check',
  'orchestration.reply'
])

export type LegacyCompatibilityRoute =
  | { handled: true; result: unknown }
  | {
      handled: false
      params?: unknown
      legacyCoordinatorAuthority?: LegacyCoordinatorAuthorityProof
      orchestrationCompatibilityCallerAuthority?: OrchestrationCompatibilityCallerAuthority
    }

export type LegacyCoordinatorInvocation = Readonly<{
  authority: LegacyCoordinatorAuthorityProof
  mutationCallerFingerprint: string
  revalidate: () => string
}>

export class OrchestrationLegacyCompatibility {
  private readonly authority: LegacyCompatibilityAuthority
  private readonly coordinatorAuthority: LegacyCoordinatorAuthority

  constructor(private readonly runtime: OrcaRuntimeService) {
    this.authority = new LegacyCompatibilityAuthority(runtime)
    this.coordinatorAuthority = new LegacyCoordinatorAuthority(runtime)
  }

  async tryHandle(
    request: RpcRequest,
    params: unknown,
    signal?: AbortSignal
  ): Promise<LegacyCompatibilityRoute> {
    if (!request.method.startsWith('orchestration.')) {
      return { handled: false }
    }
    const result = await this.route(request, params, signal)
    if (result !== undefined) {
      return { handled: true, result }
    }
    if (!COORDINATOR_PREFLIGHT_METHODS.has(request.method)) {
      return { handled: false }
    }
    const values = params as Record<string, unknown>
    if (request.method === 'orchestration.runUse' && values.takeoverLegacy === true) {
      const callerAuthority = this.runtime.verifyOrchestrationCompatibilityCaller(
        request.orchestrationCompatibilityEvidence
      )
      return {
        handled: false,
        ...(callerAuthority ? { orchestrationCompatibilityCallerAuthority: callerAuthority } : {})
      }
    }
    const requestedRunId =
      request.method === 'orchestration.runUse' ? stringValue(values.id) : stringValue(values.run)
    if (request.method === 'orchestration.taskList' && requestedRunId) {
      return { handled: false }
    }
    const authority = this.coordinatorAuthority.resolve(request, requestedRunId)
    return authority
      ? {
          handled: false,
          params: { ...values, run: authority.runId },
          legacyCoordinatorAuthority: authority
        }
      : { handled: false }
  }

  revalidateCoordinatorAuthority(
    request: RpcRequest,
    proof: LegacyCoordinatorAuthorityProof
  ): string {
    return this.coordinatorAuthority.revalidate(request, proof)
  }

  createCoordinatorInvocation(
    request: RpcRequest,
    authority?: LegacyCoordinatorAuthorityProof
  ): LegacyCoordinatorInvocation | undefined {
    return authority
      ? {
          authority,
          mutationCallerFingerprint: legacyCoordinatorMutationCallerFingerprint(authority),
          revalidate: () => this.revalidateCoordinatorAuthority(request, authority)
        }
      : undefined
  }

  private async route(
    request: RpcRequest,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown | undefined> {
    if (request.method === 'orchestration.send') {
      return await handleLegacyLifecycleSend({
        runtime: this.runtime,
        authority: this.authority,
        request,
        params: params as LegacySendParams
      })
    }
    if (request.method === 'orchestration.check') {
      return await handleLegacyCheck({
        runtime: this.runtime,
        authority: this.authority,
        request,
        params: params as LegacyCheckParams,
        signal
      })
    }
    if (request.method === 'orchestration.ask') {
      return await handleLegacyAsk({
        runtime: this.runtime,
        authority: this.authority,
        request,
        params: params as LegacyAskParams,
        signal
      })
    }
    if (request.method === 'orchestration.reply') {
      return await handleLegacyReply({
        runtime: this.runtime,
        authority: this.authority,
        request,
        params: params as LegacyReplyParams
      })
    }
    return undefined
  }
}

function legacyCoordinatorMutationCallerFingerprint(
  authority: LegacyCoordinatorAuthorityProof
): string {
  return createHash('sha256')
    .update(
      ['legacy-coordinator-v1', authority.runId, authority.terminalHandle, authority.paneKey].join(
        '\0'
      )
    )
    .digest('hex')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
