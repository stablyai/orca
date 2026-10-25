import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import { noteWslDistrosRunning } from '../../../wsl-background-distro-gate'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import {
  assertPaneStillExists,
  excludeAbsentOwnerReplay,
  PaneOwnerContentionError
} from '../pane/pane-spawn-operation'
import { excludeReplacedPaneOwner } from '../pane/replaced-pane-owner'
import { assertSpawnReplyWasLive } from '../pane/agent-session-owners'
import { failPtySpawnExecute } from '../spawn-execute-failure'
import { attachOnlyViewOf, attachViewWithoutOwner } from '../pane/attach-only-view'
import type { PtyIpcSpawnState } from './spawn-state'

export async function executePtyIpcSpawn(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  try {
    if (ctx.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.add(ctx.preAllocatedHandle)
    }
    ctx.spawnTiming.mark('options')
    // Restart must replace the stopped owner instead of reattaching its retained binding.
    const resolveOwner = () =>
      excludeReplacedPaneOwner(
        resolveStablePaneOwner(
          ctx.deps.runtime,
          ctx.deps.store,
          ctx.reservationPaneKey,
          args.worktreeId,
          args.connectionId
        ),
        ctx.replacedPaneOwner
      )
    const stablePaneOwnerCandidate = excludeAbsentOwnerReplay(
      resolveOwner(),
      ctx.paneSpawnOperation?.absentOwner
    )
    if (stablePaneOwnerCandidate) {
      throw new PaneOwnerContentionError()
    }
    if (ctx.paneSpawnOperation?.mustExist && args.worktreeId && args.tabId && args.leafId) {
      assertPaneStillExists(
        ctx.deps.store,
        args.worktreeId,
        args.tabId,
        args.leafId,
        args.connectionId
      )
    }
    const expectedPtyId = ctx.effectiveSessionAppId ?? ctx.effectiveSessionId
    if (expectedPtyId) {
      ctx.pendingRegistrationClaim = ctx.deps.runtime?.beginPtyRegistration?.(expectedPtyId)
      ctx.pendingRegistrationPtyId = expectedPtyId
    }
    if (ctx.isDaemonHostSpawn && expectedPtyId) {
      ctx.preparedProvisionalExecutionContext =
        ctx.deps.runtime?.preparePtyExecutionContext?.(expectedPtyId, ctx.expectedWslDistro, {
          resetIncarnation: ctx.isMintedSessionId && !stablePaneOwnerCandidate,
          preserveExisting: !ctx.isMintedSessionId || Boolean(stablePaneOwnerCandidate)
        }) ?? false
    }
    const sequenceBeforeProviderSpawn = expectedPtyId
      ? (ctx.deps.runtime?.getPtyOutputSequence?.(expectedPtyId) ?? 0)
      : 0
    if (!ctx.preAdoptedStablePane && ctx.paneAgentLaunch) {
      ctx.paneAgentLaunch.dispatched = true
    }
    ctx.result = attachOnlyViewOf(args)
      ? await attachViewWithoutOwner(ctx.provider, ctx.spawnOptions)
      : await ctx.provider.spawn(ctx.spawnOptions)
    ctx.stablePaneOwner = null
    ctx.rejectedRegistrationCandidate = ctx.result
    if (ctx.pendingRegistrationPtyId !== ctx.result.id) {
      if (ctx.pendingRegistrationPtyId) {
        ctx.deps.runtime?.cancelPendingPtyRegistration?.(
          ctx.pendingRegistrationPtyId,
          undefined,
          ctx.pendingRegistrationClaim
        )
      }
      ctx.pendingRegistrationClaim = ctx.deps.runtime?.beginPtyRegistration?.(
        ctx.result.id,
        ctx.result.incarnationId
      )
      ctx.pendingRegistrationPtyId = ctx.result.id
    }
    assertSpawnReplyWasLive(ctx.result)
    if (
      ctx.pendingRegistrationClaim &&
      !ctx.deps.runtime?.narrowPtyRegistration(
        ctx.result.id,
        ctx.pendingRegistrationClaim,
        ctx.result.incarnationId
      )
    ) {
      throw new PaneOwnerContentionError()
    }
    ctx.deps.runtime?.assertPtyRegistrationAllowed?.(ctx.result.id, ctx.result.incarnationId)
    if (ctx.result.providerSequence) {
      const runtimeSequenceBeforeReconcile =
        ctx.deps.runtime?.getPtyOutputSequence?.(ctx.result.id) ?? 0
      // Preserve the renderer-domain boundary needed to reconcile daemon snapshot kitty flags.
      ctx.reconciledSnapshotSeq =
        ctx.deps.runtime?.synchronizePtyOutputSequenceFromProvider?.(
          ctx.result.id,
          ctx.result.providerSequence,
          sequenceBeforeProviderSpawn
        ) ?? null
      if (runtimeSequenceBeforeReconcile > sequenceBeforeProviderSpawn) {
        ctx.snapshotKittyFlagsCoverReconciledSeq = false
      }
    }
    ensureWslHookRelayForReattach(ctx.result)
    const spawnedWslDistro =
      ctx.result.wslDistro === undefined ? ctx.expectedWslDistro : ctx.result.wslDistro
    if (spawnedWslDistro && !args.connectionId) {
      // A local WSL terminal is user-initiated, so background work held for this distro may run.
      noteWslDistrosRunning([spawnedWslDistro])
    }
    ctx.deps.runtime?.preparePtyExecutionContext?.(ctx.result.id, spawnedWslDistro)
    ctx.spawnTiming.mark('provider_spawn')
  } catch (err) {
    throw failPtySpawnExecute(ctx, err, {
      sessionId: ctx.effectiveSessionId,
      ownsNewSession: ctx.isMintedSessionId,
      telemetry: args.telemetry
    })
  } finally {
    if (ctx.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.delete(ctx.preAllocatedHandle)
    }
  }
}
