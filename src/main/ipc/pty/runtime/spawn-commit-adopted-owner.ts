import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { codexReattachedHomeRouteField } from '../host-env/codex-home'
import { resolvePaneSpawnReservation } from '../pane/spawn-reservation'
import type { PreparedPtyObservationAdmission } from '../../../runtime/runtime-pty-observation-capsule'
import type { AgentSessionClaimedSpawnResult } from '../../../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { commitRuntimePtySize } from './spawn-commit-pty-size'
import type { RuntimePtySpawnState } from './spawn-state'

/**
 * Commit path for an adopted agent-session owner. It returns before the normal
 * commit site, so the size cache, the pane reservation and the observation
 * admission all have to settle here.
 */
export function commitAdoptedAgentSessionOwner(
  ctx: RuntimePtySpawnState,
  agentSessionEnsure: AgentSessionClaimedSpawnResult,
  providerReattachLaunchIdentity: { incarnationId: PtyIncarnationId; launchAgent: TuiAgent } | null,
  observationAdmission: PreparedPtyObservationAdmission | null
) {
  const args = ctx.args
  // Why: an adoption is an attach to a live owner by definition, but the SSH relay's adopted
  // reply omits isReattach; derive it once so the size commit and the reservation agree.
  const adoptedResult = { ...ctx.result, isReattach: true }
  const owner = agentSessionEnsure.owner
  ptyOwnership.set(ctx.result.id, args.connectionId ?? ptyOwnership.get(ctx.result.id) ?? null)
  ctx.deps.runtime?.registerPreAllocatedHandleForPty(ctx.result.id, owner.surface.terminalHandle)
  if (ctx.result.incarnationId) {
    ptyIncarnationById.set(ctx.result.id, ctx.result.incarnationId)
  }
  ctx.deps.runtime?.registerPty(
    ctx.result.id,
    owner.surface.worktreeId,
    args.connectionId ?? null,
    {
      tabId: owner.surface.tabId,
      leafId: owner.surface.leafId,
      terminalHandle: owner.surface.terminalHandle,
      ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
      ...(providerReattachLaunchIdentity ? { providerReattachLaunchIdentity } : {})
    },
    undefined,
    observationAdmission
  )
  if (!args.connectionId) {
    ctx.deps.options?.onCodexHomePtySpawned?.({
      id: ctx.result.id,
      codexHomePath: ctx.selectedCodexHomePath,
      reattached: true,
      startedAt: ctx.codexHomeLaunchStartedAt,
      startedSequence: ctx.codexHomeLaunchStartedSequence,
      ...codexReattachedHomeRouteField(ctx.reattachedCodexHomeRoutes, ctx.result.id, true),
      ...(ctx.env ? { launchEnv: ctx.env } : {})
    })
  }
  // Why: this branch returns before the normal commit site; without this the cache keeps
  // whatever the caller requested.
  commitRuntimePtySize(ctx, adoptedResult)
  // Why: the adopted branch returns before the normal settle site, so the
  // reservation must be resolved here or every later spawn for this pane
  // awaits a promise that never settles.
  resolvePaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, adoptedResult)
  // Why after registerPty: a prepared admission was already accepted (and its token
  // forgotten) during promotion; this settles a token the commit could NOT prepare —
  // the only pending admission this early return would otherwise strand for the PTY id.
  ctx.deps.runtime?.cancelPtyObservationAdmission?.(ctx.observationAdmissionToken)
  ctx.observationAdmissionToken = null
  return {
    id: ctx.result.id,
    ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
    agentSessionEnsure
  }
}
