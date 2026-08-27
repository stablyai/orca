import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { ptyOwnership, ptyIncarnationById, deletePtyOwnership } from '../provider/ownership-state'
import { ptySizes } from '../delivery/visibility-state'
import { getRelayPtyId } from '../provider/registry'
import {
  shouldSkipCodexHomeEnvForWindowsShell,
  recordCodexPaneAccountForSpawn,
  codexReattachedHomeRouteField
} from '../host-env/codex-home'
import { markClaudePtySpawned } from '../../../claude-accounts/live-pty-gate'
import { registerPty } from '../../../memory/pty-registry'
import { rememberPaneKeyForPty } from '../pane/key-state'
import {
  pendingByPaneKey,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness
} from '../pane/serializer-state'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../pane/agent-session-owners'
import { track } from '../../../telemetry/client'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import {
  agentKindSchema,
  launchSourceSchema,
  requestKindSchema
} from '../../../../shared/telemetry-events'
import { persistAdmittedStablePaneBinding } from '../pane/stable-owner'
import {
  isNativeWindowsLocalPtySpawn,
  markNativeWindowsConptyPty
} from '../../../runtime/terminal-model-query-authority'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { createTerminalSessionStateSaveFailureMessage } from '../../../../shared/terminal-session-state-save-failure'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { resolvePaneSpawnReservation } from '../pane/spawn-reservation'
import type { RuntimePtySpawnState } from './spawn-state'

export async function commitRuntimePtySpawn(ctx: RuntimePtySpawnState) {
  const args = ctx.args
  try {
    ctx.stablePaneBindingPersisted = persistAdmittedStablePaneBinding({
      store: ctx.hostSessionBinding?.store,
      owner: ctx.stablePaneOwner,
      result: ctx.result,
      worktreeId: ctx.hostSessionBinding?.worktreeId,
      startupCwd: ctx.cwd,
      connectionId: args.connectionId
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'terminal_pane_owner_changed') {
      throw error
    }
    console.error('[pty] failed to persist runtime PTY binding after attach:', error)
    throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage()), {
      agentSessionOperationOutcome: 'unknown' as const
    })
  }
  if (ctx.result.agentSessionEnsure?.disposition === 'adopted') {
    const owner = ctx.result.agentSessionEnsure.owner
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
        ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {})
      }
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
    // Why: the adopted branch returns before the normal settle site, so the
    // reservation must be resolved here or every later spawn for this pane
    // awaits a promise that never settles.
    resolvePaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, {
      ...ctx.result,
      isReattach: true
    })
    return {
      id: ctx.result.id,
      ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
      agentSessionEnsure: ctx.result.agentSessionEnsure
    }
  }
  ptyOwnership.set(ctx.result.id, args.connectionId ?? null)
  if (ctx.result.incarnationId) {
    ptyIncarnationById.set(ctx.result.id, ctx.result.incarnationId)
  }
  // Why: record the native-Windows-local-PTY determination before any byte reaches the emulator, so its ConPTY DA1 override exists from byte zero.
  if (
    isNativeWindowsLocalPtySpawn({
      connectionId: args.connectionId,
      cwd: args.cwd,
      shellOverride: ctx.daemonShellOverride
    })
  ) {
    markNativeWindowsConptyPty(ctx.result.id)
  }
  const relayResultId = getRelayPtyId(args.connectionId, ctx.result.id)
  const persistSshLease = (): void => {
    if (!ctx.deps.store || !args.connectionId) {
      return
    }
    // Why: SSH leases keep relay ids for remote reconciliation, while session bindings keep app-facing ids for hydration.
    ctx.deps.store.upsertSshRemotePtyLease({
      targetId: args.connectionId,
      ptyId: relayResultId,
      ...(typeof args.worktreeId === 'string' ? { worktreeId: args.worktreeId } : {}),
      ...(typeof args.tabId === 'string' ? { tabId: args.tabId } : {}),
      ...(typeof args.leafId === 'string' && isTerminalLeafId(args.leafId)
        ? { leafId: args.leafId }
        : {}),
      state: 'attached',
      lastAttachedAt: Date.now()
    })
  }
  if (!ctx.hostSessionBinding) {
    persistSshLease()
  }
  ptySizes.set(ctx.result.id, { cols: args.cols, rows: args.rows })
  if (ctx.effectiveSessionAppId !== undefined && ctx.effectiveSessionAppId !== ctx.result.id) {
    ptySizes.delete(ctx.effectiveSessionAppId)
  }
  recordCodexPaneAccountForSpawn({
    ptyId: ctx.result.id,
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    isReattach: ctx.result.isReattach === true,
    pinnedByResume: ctx.codexResumeHomeSelected,
    launchCodexHomePath: ctx.selectedCodexHomePath,
    launchEnv: args.env,
    target: ctx.codexSelectionTarget,
    settings: ctx.deps.getSettings?.()
  })
  if (ctx.hostSessionBinding && !ctx.stablePaneBindingPersisted) {
    try {
      const binding = {
        worktreeId: ctx.hostSessionBinding.worktreeId,
        tabId: ctx.hostSessionBinding.tabId,
        leafId: ctx.hostSessionBinding.leafId,
        ptyId: ctx.result.id,
        hostAdmittedMembership: true,
        ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
        ...(ctx.cwd ? { startupCwd: ctx.cwd } : {}),
        ...(ctx.hostSessionBinding.expectedSourceBinding
          ? { expectedSourceBinding: ctx.hostSessionBinding.expectedSourceBinding }
          : {})
      }
      const persisted = args.connectionId
        ? ctx.hostSessionBinding.store.persistPtyBinding(
            binding,
            toSshExecutionHostId(args.connectionId)
          )
        : ctx.hostSessionBinding.store.persistPtyBinding(binding)
      if (persisted === false) {
        throw new Error('terminal_split_source_not_found')
      }
    } catch (err) {
      console.error('[pty] failed to persist runtime PTY binding after spawn:', err)
      if (!ctx.result.isReattach) {
        deletePtyOwnership(ctx.result.id)
        try {
          await ctx.provider.shutdown(ctx.result.id, { immediate: true })
        } catch (shutdownErr) {
          console.warn('[pty] failed to clean up PTY after persistence failure:', shutdownErr)
        }
        clearProviderPtyState(ctx.result.id)
      }
      if (err instanceof Error && err.message === 'terminal_split_source_not_found') {
        throw err
      }
      throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage()), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    }
    persistSshLease()
  }
  if (args.preAllocatedHandle && !ctx.stablePaneOwner?.handle) {
    ctx.deps.runtime?.registerPreAllocatedHandleForPty(ctx.result.id, args.preAllocatedHandle)
  }
  if (args.worktreeId) {
    ctx.deps.runtime?.registerPty(
      ctx.result.id,
      args.worktreeId,
      args.connectionId ?? null,
      // Why: thread validated pane identity so main can back a pending mobile create even if graph-sync stalls (#7587).
      typeof args.tabId === 'string' &&
        isValidTerminalTabId(args.tabId) &&
        args.tabId.length <= 512 &&
        ctx.metadataLeafId !== null
        ? {
            tabId: args.tabId,
            leafId: ctx.metadataLeafId,
            ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {})
          }
        : undefined,
      !args.connectionId
        ? shouldSkipCodexHomeEnvForWindowsShell(ctx.daemonShellOverride, ctx.cwd)
        : undefined
    )
  } else {
    // Why: non-worktree PTYs have no later surface-registration phase to clear admission intent.
    ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.result.id, ctx.result.incarnationId)
  }
  // Why: runtime-controller creates (headless serve, CLI, splits) adopt surviving daemon sessions too; without this seed their records stay blank.
  seedTerminalRestoreRecordsFromSpawnResult(ctx.deps.runtime, ctx.result)
  // Why: arms main's per-PTY Command Code output detector from the launch command (renderer startupCommand parity).
  if (!ctx.stablePaneOwner) {
    ctx.deps.runtime?.noteTerminalSpawnCommand?.(ctx.result.id, ctx.launchCommand ?? null)
  }
  if (ctx.isClaudeLaunch && !ctx.stablePaneOwner) {
    markClaudePtySpawned(ctx.result.id)
  }
  if (args.telemetry && !ctx.stablePaneOwner) {
    const agentKindParse = agentKindSchema.safeParse(args.telemetry.agent_kind)
    const launchSourceParse = launchSourceSchema.safeParse(args.telemetry.launch_source)
    const requestKindParse = requestKindSchema.safeParse(args.telemetry.request_kind)
    if (agentKindParse.success && launchSourceParse.success && requestKindParse.success) {
      track('agent_started', {
        agent_kind: agentKindParse.data,
        launch_source: launchSourceParse.data,
        request_kind: requestKindParse.data,
        ...getCohortAtEmit()
      })
    }
  }
  // Why: runtime-owned CLI PTYs bypass the renderer pty:spawn handler; record paneKey here too since hook titles and cache cleanup need this reverse lookup.
  const paneKey = rememberPaneKeyForPty(ctx.result.id, ctx.env?.ORCA_PANE_KEY)
  const pendingSerializer = paneKey ? pendingByPaneKey.get(paneKey) : undefined
  const inheritRendererReadiness =
    ctx.result.isReattach === true &&
    !pendingSerializer &&
    rendererSerializerReadiness.has(ctx.result.id)
  rendererSerializerReadiness.beginIncarnation(ctx.result.id, inheritRendererReadiness)
  if (paneKey && pendingSerializer) {
    pendingPtyIdBySerializerGeneration.set(pendingSerializer.gen, ctx.result.id)
  }
  if (!args.connectionId) {
    registerPty({
      ptyId: ctx.result.id,
      worktreeId: args.worktreeId ?? null,
      sessionId: ctx.sessionId ?? null,
      paneKey,
      pid:
        typeof ctx.result.pid === 'number' && Number.isFinite(ctx.result.pid) && ctx.result.pid > 0
          ? ctx.result.pid
          : null
    })
  }
  // Why: runtime-owned/background spawns bypass mounted-pane state, so inventory consumers need an explicit signal.
  ctx.deps.sendPtySpawnedToRenderer(ctx.result.id)
  if (!args.connectionId) {
    ctx.deps.options?.onCodexHomePtySpawned?.({
      id: ctx.result.id,
      codexHomePath: ctx.selectedCodexHomePath,
      startedAt: ctx.codexHomeLaunchStartedAt,
      startedSequence: ctx.codexHomeLaunchStartedSequence,
      ...codexReattachedHomeRouteField(
        ctx.reattachedCodexHomeRoutes,
        ctx.result.id,
        ctx.result.isReattach === true
      ),
      ...(ctx.result.isReattach === true
        ? { reattached: true }
        : ctx.env
          ? { launchEnv: ctx.env }
          : {})
    })
  }
  const response = {
    id: ctx.result.id,
    ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
    ...(ctx.stablePaneOwner && (ctx.stablePaneOwner.handle || args.preAllocatedHandle)
      ? {
          stablePaneOwner: {
            handle: ctx.stablePaneOwner.handle ?? args.preAllocatedHandle!,
            tabId: ctx.stablePaneOwner.tabId,
            leafId: ctx.stablePaneOwner.leafId
          }
        }
      : {}),
    ...(ctx.result.agentSessionEnsure ? { agentSessionEnsure: ctx.result.agentSessionEnsure } : {})
  }
  resolvePaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, {
    ...ctx.result,
    ...(typeof ctx.result.snapshotKittyKeyboardFlags === 'number' &&
    ctx.reconciledSnapshotSeq !== null &&
    ctx.snapshotKittyFlagsCoverReconciledSeq
      ? { snapshotSeq: ctx.reconciledSnapshotSeq }
      : { snapshotKittyKeyboardFlags: undefined }),
    isReattach: true
  })
  return response
}
