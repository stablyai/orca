import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import { noteWslDistrosRunning } from '../../../wsl-background-distro-gate'
import { resolveStablePaneOwner, spawnForStablePane } from '../pane/stable-owner'
import { excludeReplacedPaneOwner } from '../pane/replaced-pane-owner'
import { assertSpawnReplyWasLive } from '../pane/agent-session-owners'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { failPtySpawnExecute } from '../spawn-execute-failure'
import type { PtyIpcSpawnState } from './spawn-state'
import { keepAbsentBindingForSwap } from './spawn-absent-binding-swap'

export async function executePtyIpcSpawn(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  try {
    if (ctx.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.add(ctx.preAllocatedHandle)
    }
    ctx.spawnTiming.mark('options')
    // Why exclude: the restart's own stop leaves its binding for the bind to swap, not to reattach.
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
    const stablePaneOwnerCandidate = resolveOwner()
    const expectedPtyId =
      stablePaneOwnerCandidate?.ptyId ?? ctx.effectiveSessionAppId ?? ctx.effectiveSessionId
    if (expectedPtyId) {
      ctx.deps.runtime?.beginPtyRegistration?.(expectedPtyId)
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
    const stablePaneSpawn = ctx.preAdoptedStablePane
      ? ctx.preAdoptedStablePane
      : await spawnForStablePane({
          runtime: ctx.deps.runtime,
          store: ctx.deps.store,
          provider: ctx.provider,
          spawnOptions: ctx.spawnOptions,
          owner: stablePaneOwnerCandidate,
          worktreeId: args.worktreeId,
          connectionId: args.connectionId,
          resolveOwner,
          keepAbsentBinding: keepAbsentBindingForSwap(ctx)
        })
    ctx.result = stablePaneSpawn.result
    ctx.stablePaneOwner = stablePaneSpawn.owner
    if (
      ctx.stablePaneOwner &&
      ctx.isMintedSessionId &&
      ctx.effectiveSessionAppId &&
      ctx.effectiveSessionAppId !== ctx.result.id
    ) {
      clearProviderPtyState(ctx.effectiveSessionAppId)
    }
    ctx.rejectedRegistrationCandidate = ctx.result
    if (ctx.pendingRegistrationPtyId !== ctx.result.id) {
      if (ctx.pendingRegistrationPtyId) {
        ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.pendingRegistrationPtyId)
      }
      ctx.deps.runtime?.beginPtyRegistration?.(ctx.result.id, ctx.result.incarnationId)
      ctx.pendingRegistrationPtyId = ctx.result.id
    }
    assertSpawnReplyWasLive(ctx.result)
    ctx.deps.runtime?.assertPtyRegistrationAllowed?.(ctx.result.id, ctx.result.incarnationId)
    if (ctx.result.providerSequence) {
      const runtimeSequenceBeforeReconcile =
        ctx.deps.runtime?.getPtyOutputSequence?.(ctx.result.id) ?? 0
      // Why kept: this is the reattach boundary in the RENDERER's sequence
      // domain, and the daemon snapshot's kitty flags mean nothing without
      // the boundary they were proven at.
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
