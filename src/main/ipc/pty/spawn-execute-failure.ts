import type { PtyRegistrationClaim } from '../../runtime/runtime-terminal-state-records'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { classifyError } from '../../telemetry/classify-error'
import { track } from '../../telemetry/client'
import { getCohortAtEmit } from '../../telemetry/cohort-classifier'
import { agentKindSchema } from '../../../shared/telemetry-events'
import { normalizeNodePtySpawnError } from './provider/liveness'
import { restoreProvisionalPtySize, type PtySpawnSizeSeed } from './spawn-options-assembly'
import { clearProviderPtyState } from './provider/state-cleanup'

type PtySpawnExecuteState = {
  deps: { runtime?: OrcaRuntimeService }
  isClaudeLaunch: boolean
  effectiveSessionAppId: string | undefined
  provisionalPtySize: PtySpawnSizeSeed | undefined
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
    /** This start owns the new incarnation, including a fresh process using a supplied id. */
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
  // Preparation for an unaccepted new incarnation must not leak into a later start.
  if (lane.ownsNewSession && lane.sessionId !== undefined) {
    clearProviderPtyState(lane.sessionId)
  }
  // Restore the pre-start grid after teardown, which also clears its provisional cache entry.
  restoreProvisionalPtySize(ctx, { exitedBeforeSpawnReply })
  // Attribute validated agent identity; telemetry never receives raw provider errors.
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
