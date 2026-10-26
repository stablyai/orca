import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { codexReattachedHomeRouteField } from '../host-env/codex-home'
import type { PaneSpawnOperation } from '../pane/pane-spawn-operation'
import {
  rejectPaneSpawnReservation,
  reserveIdlePaneSpawn,
  pendingRuntimePaneCreatesByOwnerKey
} from '../pane/spawn-reservation'
import { restoreProvisionalPtySize } from '../spawn-options-assembly'
import {
  beginPtyIpcSpawn,
  resolveEarlyPaneKey,
  resolveEarlyPaneSpawnReservationKey
} from './spawn-begin'
import { releaseStoppedPaneBinding, stopReplacedPaneOwner } from '../pane/pane-owner-replacement'
import { keepAbsentBindingForSwap } from './spawn-absent-binding-swap'
import { planPaneAgentLaunch } from './spawn-agent-launch'
import { endPaneAgentLaunch } from './spawn-agent-launch-end'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { preparePtyIpcQoderCommand } from './spawn-qoder-command'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { executePtyIpcSpawn } from './spawn-execute'
import { attachOnlyViewOf } from '../pane/attach-only-view'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './spawn-state'
import { triggerPtySpawnPushTargetMaterialization } from './spawn-push-target-materialization'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { refuseClosedPaneSpawn } from './closed-pane-spawn-refusal'
import {
  captureSavedResumeCleanup,
  admitColdRestoreReattach,
  forgetRefusedResume,
  resumeSpawnRefusal,
  savedResumeRecord
} from '../host-env/saved-resume-admission'

function releaseAbandonedAgentTeamsLeader(ctx: PtyIpcSpawnState): void {
  if (!ctx.agentTeamsLeaderHandle) {
    return
  }
  ctx.deps.runtime?.releaseClaudeAgentTeamsLeaderForHandle?.(ctx.agentTeamsLeaderHandle)
  ctx.agentTeamsLeaderHandle = null
}

export async function runPtyIpcSpawn(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  const ctx = createPtyIpcSpawnState(deps, args)
  const replacedPaneKey =
    args.replacesPtyId !== undefined ? resolveEarlyPaneSpawnReservationKey(args) : null
  if (replacedPaneKey) {
    // Reserve through stop so concurrent reveals join the replacement instead of the dying owner.
    ctx.paneSpawnReservation = await reserveIdlePaneSpawn(replacedPaneKey)
    ctx.paneSpawnReservationKey = replacedPaneKey
  }
  const fresh = async (operation: PaneSpawnOperation) => {
    // Retire the previous preparation before replacing its resource slots or reacquiring its lease.
    releaseAbandonedAgentTeamsLeader(ctx)
    ctx.finishTerminalInstall()
    ctx.finishTerminalInstall = () => {}
    ctx.releaseWorktreeSpawn?.()
    ctx.releaseWorktreeSpawn = undefined
    ctx.paneSpawnOperation = operation
    ctx.paneSpawnReservation = null
    ctx.earlyStablePaneOwner = null
    // Avoid a new await for ordinary spawns; launch planning alone needs this yield.
    if (ctx.args.agentLaunch !== undefined) {
      await planPaneAgentLaunch(ctx)
    }
    await preparePtyIpcSpawnPreflight(ctx)
    await assemblePtyIpcSpawnEnv(ctx)
    await preparePtyIpcQoderCommand(ctx)
    await buildPtyIpcSpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize({
        sessionId: ctx.effectiveSessionId,
        sessionAppId: ctx.effectiveSessionAppId,
        hadSessionSizeBeforeAttach: ctx.hadSessionSizeBeforeAttach,
        sessionSizeBeforeAttach: ctx.sessionSizeBeforeAttach
      })
      throw error
    })
    const complete = async (scope: PaneSpawnOperation) => {
      ctx.paneSpawnOperation = scope
      // Check immediately before spawn, with no intervening await, so closed panes cannot start commands.
      ctx.paneAgentLaunch?.refuseIfClosed()
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        refuseClosedPaneSpawn(deps.store, args.tabId, args.leafId)
      }
      try {
        await executePtyIpcSpawn(ctx)
        if (!ctx.resumeAdmission) {
          ctx.resumeAdmission = await admitColdRestoreReattach(
            deps.runtime,
            ctx.result,
            { paneKey: ctx.stablePaneKey, saved: savedResumeRecord(deps.store, ctx.stablePaneKey) },
            ctx.expectedWslDistro
          )
          await captureSavedResumeCleanup(
            deps.runtime,
            deps.store,
            ctx.stablePaneKey,
            ctx.resumeAdmission,
            args.worktreeId
          )
        }
        const committed = await commitPtyIpcSpawn(ctx)
        const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
        forgetRefusedResume(ctx.stablePaneKey, refusal)
        if (args.worktreeId && ctx.stablePaneKey && refusal && refusal.verdict !== 'unverifiable') {
          void deps.runtime
            ?.forgetRefusedSavedResume?.(
              args.worktreeId,
              ctx.stablePaneKey,
              refusal.refused,
              refusal.sourceRecord
            )
            .catch((error: unknown) => console.warn('[pty] refused resume cleanup failed', error))
        }
        endPaneAgentLaunch(
          ctx,
          ctx.exitedBeforeRegistration ? { exitedDuringStart: true } : { started: true }
        )
        if (!ctx.result.isReattach) {
          deps.runtime?.rememberSavedTerminalLaunchResult?.(committed.id, committed)
        }
        return committed
      } finally {
        if (ctx.pendingRegistrationPtyId) {
          deps.runtime?.cancelPendingPtyRegistration?.(
            ctx.pendingRegistrationPtyId,
            ctx.rejectedRegistrationCandidate?.incarnationId,
            ctx.pendingRegistrationClaim
          )
          ctx.pendingRegistrationPtyId = null
        }
      }
    }
    const latePane =
      !resolveEarlyPaneKey(args) && ctx.reservationPaneKey
        ? parsePaneKey(ctx.reservationPaneKey)
        : null
    if (latePane) {
      const pendingCreate = ctx.paneSpawnReservationKey
        ? pendingRuntimePaneCreatesByOwnerKey.get(ctx.paneSpawnReservationKey)
        : undefined
      if (pendingCreate) {
        await pendingCreate.promise
      }
      ctx.args = { ...ctx.args, ...latePane }
      let completed: Awaited<ReturnType<typeof complete>> | undefined
      const adopted = await deps.adoptStablePane({
        cols: args.cols,
        rows: args.rows,
        cwd: ctx.cwd,
        worktreeId: args.worktreeId,
        ...latePane,
        connectionId: args.connectionId,
        renderer: true,
        keepAbsentBinding: keepAbsentBindingForSwap(ctx),
        attachOnlyView: attachOnlyViewOf(args),
        spawnFresh: async (scope) => (completed = await complete(scope))
      })
      if (adopted) {
        releaseAbandonedAgentTeamsLeader(ctx)
      }
      return adopted
        ? { ...adopted.result, ...deps.runtime?.getTerminalLaunchResult?.(adopted.result.id) }
        : completed!
    }
    return complete(operation)
  }
  try {
    if (args.replacesPtyId !== undefined) {
      ctx.replacedPaneOwner = await stopReplacedPaneOwner(deps, {
        replacesPtyId: args.replacesPtyId,
        paneKey: resolveEarlyPaneKey(args),
        worktreeId: args.worktreeId,
        connectionId: args.connectionId
      })
    }
    triggerPtySpawnPushTargetMaterialization(deps, args)
    const early = await beginPtyIpcSpawn(ctx)
    if (early) {
      return early
    }
    const paneKey = resolveEarlyPaneKey(args)
    if (!paneKey || !args.worktreeId || !args.tabId || !args.leafId) {
      return await fresh({ mustExist: false })
    }
    let freshResult: Awaited<ReturnType<typeof fresh>> | undefined
    const adopted = await deps.adoptStablePane({
      cols: args.cols,
      rows: args.rows,
      cwd: ctx.cwd,
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: args.leafId,
      connectionId: args.connectionId,
      renderer: true,
      reservation: ctx.paneSpawnReservation ?? undefined,
      stoppedPtyId: ctx.replacedPaneOwner?.ptyId,
      keepAbsentBinding: keepAbsentBindingForSwap(ctx),
      attachOnlyView: attachOnlyViewOf(args),
      spawnFresh: async (operation) => (freshResult = await fresh(operation))
    })
    if (adopted) {
      releaseAbandonedAgentTeamsLeader(ctx)
      if (ctx.preSpawnHiddenMarkId !== null) {
        deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
      }
      deps.options?.onCodexHomePtySpawned?.({
        id: adopted.result.id,
        codexHomePath: null,
        reattached: true,
        startedAt: ctx.codexHomeLaunchStartedAt,
        startedSequence: ctx.codexHomeLaunchStartedSequence,
        ...codexReattachedHomeRouteField(ctx.reattachedCodexHomeRoutes, adopted.result.id, true)
      })
      endPaneAgentLaunch(ctx, { started: true })
      return { ...adopted.result, ...deps.runtime?.getTerminalLaunchResult?.(adopted.result.id) }
    }
    return freshResult!
  } catch (caught) {
    const err = endPaneAgentLaunch(ctx, { error: caught }) ?? caught
    releaseAbandonedAgentTeamsLeader(ctx)
    if (ctx.preSpawnHiddenMarkId !== null) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId,
        ctx.pendingRegistrationClaim
      )
      ctx.pendingRegistrationPtyId = null
    }
    if (ctx.replacedPaneOwner) {
      await releaseStoppedPaneBinding(deps.store, ctx.replacedPaneOwner)
    }
    // Settle reservations on every later failure, including post-spawn saves/helpers, or future pane spawns hang forever.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
