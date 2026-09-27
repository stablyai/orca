import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { closeStartupQueryAuthorityForPty, getRelayPtyId } from '../provider/registry'
import { createTerminalSessionStateSaveFailureMessage } from '../../../../shared/terminal-session-state-save-failure'
import { recordCodexPaneAccountForSpawn } from '../host-env/codex-home'
import { persistAdmittedStablePaneBinding } from '../pane/stable-owner'
import { claimSshPaneLease } from '../pane/ssh-pane-lease-claim'
import {
  pendingByPaneKey,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness
} from '../pane/serializer-state'
import { ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { ptySizes } from '../delivery/visibility-state'
import { resolveCommittedPtySize, type PtyGrid } from '../delivery/attached-pty-size'
import { discardUnpersistedPtySpawn } from '../pane/spawn-registration'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'
import type { PtyIpcSpawnState } from './spawn-state'

export async function persistPtyIpcSpawnCommit(ctx: PtyIpcSpawnState): Promise<PtyGrid> {
  const args = ctx.args
  try {
    ctx.stablePaneBindingPersisted = await persistAdmittedStablePaneBinding({
      store: ctx.deps.store,
      owner: ctx.stablePaneOwner,
      result: ctx.result,
      worktreeId: args.worktreeId,
      startupCwd: ctx.cwd,
      connectionId: args.connectionId
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'terminal_pane_owner_changed') {
      throw error
    }
    console.error('[pty] failed to persist PTY binding after attach:', error)
    throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage()), {
      agentSessionOperationOutcome: 'unknown' as const
    })
  }
  const committedSize = resolveCommittedPtySize({
    result: ctx.result,
    requested: { cols: args.cols, rows: args.rows },
    cachedBeforeAttach: ctx.sessionSizeBeforeAttach
  })
  const relayResultId = getRelayPtyId(args.connectionId, ctx.result.id)
  // Persist the binding before acknowledging spawn so the renderer debounce cannot orphan history.
  if (
    ctx.deps.store &&
    typeof args.worktreeId === 'string' &&
    typeof args.tabId === 'string' &&
    ctx.validatedLeafId !== null &&
    !ctx.stablePaneBindingPersisted
  ) {
    try {
      const binding = {
        worktreeId: args.worktreeId,
        tabId: args.tabId,
        leafId: ctx.validatedLeafId,
        ptyId: ctx.result.id,
        ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
        ...(ctx.cwd ? { startupCwd: ctx.cwd } : {}),
        origin: spawnCommitBindingOrigin(ctx.result)
      }
      const persisted = args.connectionId
        ? await ctx.deps.store.persistPtyBinding(binding, toSshExecutionHostId(args.connectionId))
        : await ctx.deps.store.persistPtyBinding(binding)
      if (persisted === false) {
        throw new Error('terminal_pane_owner_changed')
      }
    } catch (err) {
      console.error('[pty] failed to persist PTY binding after spawn:', err)
      await discardUnpersistedPtySpawn(ctx.provider, ctx.result, () => {
        if (args.connectionId && ctx.deps.store) {
          ctx.deps.store.removeSshRemotePtyLease(args.connectionId, relayResultId)
        }
      })
      throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage()), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    }
  }
  return committedSize
}

export function publishPtyIpcSpawnCommit(ctx: PtyIpcSpawnState, committedSize: PtyGrid): void {
  const args = ctx.args
  ctx.spawnTiming.log(ctx.result.id, {
    daemon: ctx.isDaemonHostSpawn,
    reattach: ctx.result.isReattach ?? false
  })
  recordCodexPaneAccountForSpawn({
    ptyId: ctx.result.id,
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    isReattach: ctx.result.isReattach === true,
    pinnedByResume: ctx.codexResumeHomeSelected,
    launchCodexHomePath: ctx.selectedCodexHomePath,
    launchEnv: ctx.baseEnv,
    target: ctx.codexSelectionTarget,
    settings: ctx.deps.getSettings?.()
  })
  ptyOwnership.set(ctx.result.id, args.connectionId ?? null)
  if (ctx.result.incarnationId) {
    ptyIncarnationById.set(ctx.result.id, ctx.result.incarnationId)
  }
  if (ctx.initiallyHidden) {
    // Refresh the pre-spawn hidden mark only after this incarnation survives its save.
    ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.result.id, true)
    if (ctx.preSpawnHiddenMarkId !== null && ctx.preSpawnHiddenMarkId !== ctx.result.id) {
      // Defense: never strand a mark on an id the provider renamed.
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    // Why after ptyOwnership.set: provider lookup routes by ownership, and a hidden-spawned agent should be paceable from its first flood.
    ctx.deps.syncPtyBackgroundedDelivery(ctx.result.id, 'spawn')
    closeStartupQueryAuthorityForPty(ctx.result.id)
  }
  if (ctx.preAllocatedHandle && !ctx.stablePaneOwner?.handle) {
    if (ctx.deps.runtime?.registerPreAllocatedHandleForPty) {
      ctx.deps.runtime.registerPreAllocatedHandleForPty(ctx.result.id, ctx.preAllocatedHandle)
      ctx.agentTeamsLeaderHandle = null
    }
  }
  ptySizes.set(ctx.result.id, committedSize)
  if (ctx.effectiveSessionAppId !== undefined && ctx.effectiveSessionAppId !== ctx.result.id) {
    ptySizes.delete(ctx.effectiveSessionAppId)
  }
  claimSshPaneLease({
    store: ctx.deps.store,
    connectionId: args.connectionId,
    ptyId: ctx.result.id,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: ctx.validatedLeafId ?? undefined
  })
  const rendererPreSignaled = ctx.validatedPaneKey
    ? pendingByPaneKey.has(ctx.validatedPaneKey)
    : false
  const rendererAlreadyRegistered =
    ctx.result.isReattach === true &&
    !rendererPreSignaled &&
    rendererSerializerReadiness.has(ctx.result.id)
  rendererSerializerReadiness.beginIncarnation(ctx.result.id, rendererAlreadyRegistered)
  // Why: capture the pending gen at spawn time so this PTY's teardown only settles its own generation, not a remount that replaced the entry.
  if (ctx.validatedPaneKey && rendererPreSignaled) {
    const pending = pendingByPaneKey.get(ctx.validatedPaneKey)
    if (pending) {
      pendingPtyIdBySerializerGeneration.set(pending.gen, ctx.result.id)
    }
  }
}
