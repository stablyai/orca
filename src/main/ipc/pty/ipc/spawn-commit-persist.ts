import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { markNativeWindowsConptyPty } from '../../../runtime/terminal-model-query-authority'
import { closeStartupQueryAuthorityForPty, getRelayPtyId } from '../provider/registry'
import { createTerminalSessionStateSaveFailureMessage } from '../../../../shared/terminal-session-state-save-failure'
import { recordCodexPaneAccountForSpawn } from '../host-env/codex-home'
import { persistAdmittedStablePaneBinding } from '../pane/stable-owner'
import {
  pendingByPaneKey,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness
} from '../pane/serializer-state'
import { ptyOwnership, ptyIncarnationById, deletePtyOwnership } from '../provider/ownership-state'
import { ptySizes } from '../delivery/visibility-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import type { PtyIpcSpawnState } from './spawn-state'

export async function persistPtyIpcSpawnCommit(ctx: PtyIpcSpawnState): Promise<{
  rendererPreSignaled: boolean
  rendererAlreadyRegistered: boolean
}> {
  const args = ctx.args
  try {
    ctx.stablePaneBindingPersisted = persistAdmittedStablePaneBinding({
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
    // Why marked synchronously here: provider data events dispatch on later tasks, so this still lands ahead of the first byte's delivery decision (idempotent if already marked pre-spawn).
    ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.result.id, true)
    if (ctx.preSpawnHiddenMarkId !== null && ctx.preSpawnHiddenMarkId !== ctx.result.id) {
      // Defense: never strand a mark on an id the provider renamed.
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    // Why after ptyOwnership.set: provider lookup routes by ownership, and a hidden-spawned agent should be paceable from its first flood.
    ctx.deps.syncPtyBackgroundedDelivery(ctx.result.id, 'spawn')
    closeStartupQueryAuthorityForPty(ctx.result.id)
  }
  // Why: record the native-Windows-ConPTY determination before the headless seed so the emulator's DA1 override exists from byte zero.
  if (ctx.nativeWindowsConptySpawn) {
    markNativeWindowsConptyPty(ctx.result.id)
  }
  const relayResultId = getRelayPtyId(args.connectionId, ctx.result.id)
  if (ctx.deps.store && args.connectionId) {
    // Why: remote PTYs live in the SSH relay grace window after Orca detaches; persist IDs immediately so reconnect reattaches instead of spawning a fresh shell.
    ctx.deps.store.upsertSshRemotePtyLease({
      targetId: args.connectionId,
      ptyId: relayResultId,
      ...(typeof args.worktreeId === 'string' ? { worktreeId: args.worktreeId } : {}),
      ...(typeof args.tabId === 'string' ? { tabId: args.tabId } : {}),
      ...(ctx.validatedLeafId ? { leafId: ctx.validatedLeafId } : {}),
      state: 'attached',
      lastAttachedAt: Date.now()
    })
  }
  if (ctx.preAllocatedHandle && !ctx.stablePaneOwner?.handle) {
    if (ctx.deps.runtime?.registerPreAllocatedHandleForPty) {
      ctx.deps.runtime.registerPreAllocatedHandleForPty(ctx.result.id, ctx.preAllocatedHandle)
      ctx.agentTeamsLeaderHandle = null
    }
  }
  ptySizes.set(ctx.result.id, { cols: args.cols, rows: args.rows })
  if (ctx.effectiveSessionAppId !== undefined && ctx.effectiveSessionAppId !== ctx.result.id) {
    ptySizes.delete(ctx.effectiveSessionAppId)
  }
  // Why: patch the load-bearing ptyId binding synchronously so a force-quit in the renderer's ~450 ms debounce window can't orphan daemon history or an SSH relay lease (Issue #217).
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
        ...(ctx.cwd ? { startupCwd: ctx.cwd } : {})
      }
      if (args.connectionId) {
        ctx.deps.store.persistPtyBinding(binding, toSshExecutionHostId(args.connectionId))
      } else {
        ctx.deps.store.persistPtyBinding(binding)
      }
    } catch (err) {
      console.error('[pty] failed to persist PTY binding after spawn:', err)
      if (!ctx.result.isReattach) {
        try {
          await ctx.provider.shutdown(ctx.result.id, { immediate: true })
        } catch (shutdownErr) {
          console.warn('[pty] failed to clean up PTY after persistence failure:', shutdownErr)
        }
        clearProviderPtyState(ctx.result.id)
        deletePtyOwnership(ctx.result.id)
      }
      if (!ctx.result.isReattach && args.connectionId && ctx.deps.store) {
        ctx.deps.store.removeSshRemotePtyLease(args.connectionId, relayResultId)
      }
      throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage()), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    }
  }
  // Why: when the renderer has declared it will own the serializer for this paneKey, suppress the daemon-snapshot seed so its hydration path is sole authority (keyed on paneKey since the ptyId isn't known yet). See docs/mobile-prefer-renderer-scrollback.md.
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
  return { rendererPreSignaled, rendererAlreadyRegistered }
}
