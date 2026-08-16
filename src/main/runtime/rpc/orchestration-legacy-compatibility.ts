import { createHash } from 'node:crypto'
import type { LegacyCoordinatorAuthorityProof, RpcRequest } from './core'
import type { OrcaRuntimeService, OrchestrationCompatibilityCallerAuthority } from '../orca-runtime'
import { CURRENT_CONTRACT_VERSION } from '../orchestration/db'
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

const CURRENT_AUTHORITY_PREFLIGHT_METHODS = new Set([
  ...COORDINATOR_PREFLIGHT_METHODS,
  'orchestration.ask'
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
    const values = params as Record<string, unknown>
    if (CURRENT_AUTHORITY_PREFLIGHT_METHODS.has(request.method)) {
      const callerAuthority = this.resolveCurrentAuthority(request, values)
      if (callerAuthority) {
        return {
          handled: false,
          orchestrationCompatibilityCallerAuthority: callerAuthority
        }
      }
    }
    const result = await this.route(request, params, signal)
    if (result !== undefined) {
      return { handled: true, result }
    }
    if (!COORDINATOR_PREFLIGHT_METHODS.has(request.method)) {
      return { handled: false }
    }
    if (request.method === 'orchestration.runUse' && values.takeoverLegacy === true) {
      // Why: takeover is a current-contract recovery action. An exact fresh runtime launch
      // already proves its live PTY, process, pane, host, handle, and launch secret.
      const callerAuthority = this.runtime.verifyOrchestrationCompatibilityCaller(
        request.orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
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

  private resolveCurrentAuthority(
    request: RpcRequest,
    params: Record<string, unknown>
  ): OrchestrationCompatibilityCallerAuthority | undefined {
    const db = this.runtime.getOrchestrationDb()
    const adoption = db.getLegacyAdoption()
    if (!adoption || stringValue(params.run) || request.method === 'orchestration.runUse') {
      return undefined
    }
    const evidence = request.orchestrationCompatibilityEvidence
    if (!evidence?.terminalHandle || !evidence.paneKey) {
      return undefined
    }
    const claimedHandle = currentCallerHandle(request.method, params)
    if (claimedHandle && claimedHandle !== evidence.terminalHandle) {
      return undefined
    }
    const dispatch = db.getActiveDispatchForIdentity(evidence.terminalHandle, evidence.paneKey)
    if (dispatch) {
      if (dispatch.contract_version !== CURRENT_CONTRACT_VERSION) {
        return undefined
      }
      const caller = this.runtime.verifyOrchestrationCompatibilityCaller(evidence)
      return caller &&
        caller.terminalHandle === evidence.terminalHandle &&
        db.getActiveDispatchForIdentity(caller.terminalHandle, caller.paneKey)?.id === dispatch.id
        ? caller
        : undefined
    }
    const remoteAttachment = db.findActiveRemoteAttachmentForPane(evidence.paneKey)
    if (remoteAttachment) {
      const caller = this.runtime.verifyOrchestrationCompatibilityCaller(evidence)
      return caller &&
        caller.terminalHandle === evidence.terminalHandle &&
        db.findActiveRemoteAttachmentForPane(caller.paneKey)?.dispatch_id ===
          remoteAttachment.dispatch_id
        ? caller
        : undefined
    }
    const boundRun = db.getCurrentRunForPane(evidence.paneKey)
    if (!boundRun) {
      return undefined
    }
    const legacyCandidate =
      boundRun.id === adoption.adopted_run_id
        ? db.resolveLegacyCoordinatorCandidate({
            runId: adoption.adopted_run_id,
            terminalHandle: evidence.terminalHandle,
            paneKey: evidence.paneKey
          })
        : undefined
    if (legacyCandidate) {
      return undefined
    }
    const caller = this.runtime.verifyOrchestrationCompatibilityCaller(evidence)
    if (
      !caller ||
      caller.terminalHandle !== evidence.terminalHandle ||
      db.getCurrentRunForPane(caller.paneKey)?.id !== boundRun.id
    ) {
      return undefined
    }
    if (boundRun.id !== adoption.adopted_run_id) {
      return caller
    }
    return !db.resolveLegacyCoordinatorCandidate({
      runId: adoption.adopted_run_id,
      terminalHandle: caller.terminalHandle,
      paneKey: caller.paneKey
    })
      ? caller
      : undefined
  }

  private async route(
    request: RpcRequest,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
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

function currentCallerHandle(method: string, params: Record<string, unknown>): string | undefined {
  if (
    method === 'orchestration.taskCreate' ||
    method === 'orchestration.taskList' ||
    method === 'orchestration.taskUpdate'
  ) {
    return stringValue(params.callerTerminalHandle)
  }
  if (method === 'orchestration.check') {
    return stringValue(params.terminal)
  }
  return stringValue(params.from)
}
