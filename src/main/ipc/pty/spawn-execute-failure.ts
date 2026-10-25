import type { PtyRegistrationClaim } from '../../runtime/runtime-terminal-state-records'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { classifyError } from '../../telemetry/classify-error'
import { track } from '../../telemetry/client'
import { getCohortAtEmit } from '../../telemetry/cohort-classifier'
import { agentKindSchema } from '../../../shared/telemetry-events'
import { normalizeNodePtySpawnError } from './provider/liveness'
import { ptySizes } from './delivery/visibility-state'
import { clearProviderPtyState } from './provider/state-cleanup'

type PtySpawnExecuteState = {
  deps: { runtime?: OrcaRuntimeService }
  isClaudeLaunch: boolean
  effectiveSessionAppId: string | undefined
  hadSessionSizeBeforeAttach: boolean
  sessionSizeBeforeAttach: { cols: number; rows: number } | undefined
  preparedProvisionalExecutionContext: boolean
  pendingRegistrationPtyId: string | null
  pendingRegistrationClaim?: PtyRegistrationClaim
  rejectedRegistrationCandidate: PtySpawnResult | null
}

export function failPtySpawnExecute(
  ctx: PtySpawnExecuteState,
  err: unknown,
  lane: {
    sessionId: string | undefined
    /** This spawn minted the session id, so the state built for it must go. */
    ownsNewSession: boolean
    telemetry: { agent_kind?: unknown } | undefined
    /** This request awaited another request's claimed start, whose own catch records its failure. */
    joinedAnotherStart?: boolean
  }
): Error {
  const runtime = ctx.deps.runtime
  if (
    (lane.ownsNewSession || ctx.preparedProvisionalExecutionContext) &&
    ctx.effectiveSessionAppId
  ) {
    runtime?.preparePtyExecutionContext?.(ctx.effectiveSessionAppId, null, {
      resetIncarnation: true
    })
  }
  if (ctx.pendingRegistrationPtyId) {
    runtime?.cancelPendingPtyRegistration?.(
      ctx.pendingRegistrationPtyId,
      ctx.rejectedRegistrationCandidate?.incarnationId,
      ctx.pendingRegistrationClaim
    )
    ctx.pendingRegistrationPtyId = null
  }
  const spawnError = normalizeNodePtySpawnError(err)
  const exitedBeforeSpawnReply = ctx.rejectedRegistrationCandidate?.exitedBeforeSpawnReply === true
  if (ctx.effectiveSessionAppId !== undefined) {
    if (ctx.hadSessionSizeBeforeAttach && ctx.sessionSizeBeforeAttach && !exitedBeforeSpawnReply) {
      ptySizes.set(ctx.effectiveSessionAppId, ctx.sessionSizeBeforeAttach)
    } else {
      ptySizes.delete(ctx.effectiveSessionAppId)
    }
  }
  // Environment assembly may create per-PTY state; remove it only for this request's minted ID.
  if (lane.ownsNewSession && lane.sessionId !== undefined) {
    clearProviderPtyState(lane.sessionId)
  }
  // Prefer validated threaded agent kind; fallback detects Claude and never records raw error messages.
  const threadedKind =
    lane.telemetry?.agent_kind !== undefined
      ? agentKindSchema.safeParse(lane.telemetry.agent_kind)
      : null
  const agentKind = threadedKind?.success
    ? threadedKind.data
    : ctx.isClaudeLaunch
      ? ('claude-code' as const)
      : null
  if (agentKind && !lane.joinedAnotherStart) {
    track('agent_error', {
      agent_kind: agentKind,
      error_class: classifyError(spawnError).error_class,
      ...getCohortAtEmit()
    })
  }
  return spawnError
}
