import { rejectPaneSpawnReservation } from '../pane/spawn-reservation'
import { ptySizes } from '../delivery/visibility-state'
import { beginPtyIpcSpawn } from './spawn-begin'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { executePtyIpcSpawn } from './spawn-execute'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './spawn-state'
import { triggerPtySpawnPushTargetMaterialization } from './spawn-push-target-materialization'
import { createPtySpawnPreparationDeadline } from '../pty-spawn-preparation-deadline'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

function releaseAbandonedAgentTeamsLeader(ctx: PtyIpcSpawnState): void {
  if (!ctx.agentTeamsLeaderHandle) {
    return
  }
  ctx.deps.runtime?.releaseClaudeAgentTeamsLeaderForHandle?.(ctx.agentTeamsLeaderHandle)
  ctx.agentTeamsLeaderHandle = null
}

function restoreProvisionalPtySize(ctx: PtyIpcSpawnState): void {
  if (ctx.effectiveSessionId === undefined) {
    return
  }
  const key = ctx.effectiveSessionAppId ?? ctx.effectiveSessionId
  if (ctx.hadSessionSizeBeforeAttach && ctx.sessionSizeBeforeAttach) {
    ptySizes.set(key, ctx.sessionSizeBeforeAttach)
  } else {
    ptySizes.delete(key)
  }
}

export async function runPtyIpcSpawn(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  triggerPtySpawnPushTargetMaterialization(deps, args)
  const ctx = createPtyIpcSpawnState(deps, args)
  const preparationDeadline = createPtySpawnPreparationDeadline({
    onTimeout: () =>
      rejectPaneSpawnReservation(
        ctx.paneSpawnReservationKey,
        ctx.paneSpawnReservation,
        new Error('PTY spawn preparation timed out before provider spawn')
      )
  })
  preparationDeadline.start()
  const operation = (async () => {
    const early = await beginPtyIpcSpawn(ctx)
    if (early) {
      return early
    }
    return await runPtyIpcSpawnAfterBegin(deps, ctx, preparationDeadline)
  })()
  return preparationDeadline.race(operation)
}

async function runPtyIpcSpawnAfterBegin(
  deps: PtySpawnIpcDeps,
  ctx: PtyIpcSpawnState,
  preparationDeadline: ReturnType<typeof createPtySpawnPreparationDeadline>
) {
  preparationDeadline.assertPreparing()
  try {
    await preparePtyIpcSpawnPreflight(ctx)
    preparationDeadline.assertPreparing()
    await assemblePtyIpcSpawnEnv(ctx)
    preparationDeadline.assertPreparing()
    const earlyReserved = await buildPtyIpcSpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize(ctx)
      throw error
    })
    preparationDeadline.assertPreparing()
    if (earlyReserved) {
      // Why: this request lost the pane to the reservation winner, so its
      // pre-allocated leader handle never binds to a PTY. Nothing else can
      // evict the team env assembly created for it — exit/close cleanup keys
      // off handleByPtyId — so every lost race would leak one team forever.
      releaseAbandonedAgentTeamsLeader(ctx)
      return earlyReserved
    }
    preparationDeadline.finish()
    await executePtyIpcSpawn(ctx)
    return await commitPtyIpcSpawn(ctx)
  } catch (err) {
    releaseAbandonedAgentTeamsLeader(ctx)
    if (ctx.preSpawnHiddenMarkId !== null) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw —
    // spawn failure, persist failure, or a post-spawn helper such as
    // seedHeadlessTerminal/registerPty/track — must settle it. Otherwise
    // it lingers in paneSpawnReservationsByOwnerKey and every future spawn
    // for this pane awaits a promise that never resolves. reject is a
    // no-op once the reservation has already resolved.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
