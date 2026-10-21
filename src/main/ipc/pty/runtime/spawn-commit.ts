import { completeRuntimeSpawnResponse } from './spawn-commit-response'
import type { Store } from '../../../persistence'
import type { PersistPtyBindingArgs } from '../../../persistence/loading-store/pty-binding-persistence'
import { ptyBindingIsRefused } from '../../../persistence/loading-store/pty-binding-refusals'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  isAbsentBindingReplay,
  PaneOwnerContentionError,
  type AbsentPaneBinding
} from '../pane/pane-spawn-operation'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { ptySizes } from '../delivery/visibility-state'
import { commitRuntimePtySize } from './spawn-commit-pty-size'
import {
  shouldSkipCodexHomeEnvForWindowsShell,
  recordCodexPaneAccountForSpawn,
  codexReattachedHomeRouteField
} from '../host-env/codex-home'
import { registerPty } from '../../../memory/pty-registry'
import { rememberPaneKeyForPty } from '../pane/key-state'
import {
  pendingByPaneKey,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness
} from '../pane/serializer-state'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../pane/agent-session-owners'
import { seedResumeLaunchIdentityFromSpawn } from '../pane/resume-launch-identity'
import { seedHeadlessTerminalFromSpawnResult } from '../pane/terminal-spawn-restore'
import { recordPtySpawnTelemetry } from '../pane/spawn-telemetry'
import {
  isNativeWindowsLocalPtySpawn,
  markNativeWindowsConptyPty
} from '../../../runtime/terminal-model-query-authority'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { createTerminalSessionStateSaveFailureMessage } from '../../../../shared/terminal-session-state-save-failure'
import { resolvePaneSpawnReservation } from '../pane/spawn-reservation'
import { admitProviderReattachLaunchIdentity } from '../pane/launch-authority'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'
import type { RuntimePtySpawnState } from './spawn-state'
import { commitPtyWithOpenCodePromptIntent } from '../../../opencode/opencode-startup-prompt-owner'
import {
  admitPtySpawnOwnership,
  discardUnpersistedPtySpawn,
  registerPersistedPtySpawn
} from '../pane/spawn-registration'

export async function commitRuntimePtySpawn(ctx: RuntimePtySpawnState) {
  return commitPtyWithOpenCodePromptIntent(ctx, () => commitReservedRuntimePtySpawn(ctx))
}

async function commitReservedRuntimePtySpawn(ctx: RuntimePtySpawnState) {
  const args = ctx.args
  admitPtySpawnOwnership(ctx.deps.runtime, ctx.result)
  const providerReattachLaunchIdentity = admitProviderReattachLaunchIdentity(ctx.result)
  if (
    isNativeWindowsLocalPtySpawn({
      connectionId: args.connectionId,
      cwd: args.cwd,
      shellOverride: ctx.daemonShellOverride
    })
  ) {
    markNativeWindowsConptyPty(ctx.result.id)
  }
  // Seed before the first disk await so live output appends to the restored history.
  seedHeadlessTerminalFromSpawnResult(ctx.deps.runtime, ctx.result, ctx.spawnIdentityPaneKey)
  seedTerminalRestoreRecordsFromSpawnResult(ctx.deps.runtime, ctx.result)

  if (ctx.result.agentSessionEnsure?.disposition === 'adopted') {
    // Why: an adoption is an attach to a live owner by definition, but an adopted reply can omit
    // isReattach; derive it once so the size commit and the reservation agree.
    const adoptedResult = { ...ctx.result, isReattach: true }
    const owner = ctx.result.agentSessionEnsure.owner
    const rejectedRegistration = registerPersistedPtySpawn(
      ctx.deps.runtime,
      ctx.hostSessionBinding?.store ?? ctx.deps.store,
      ctx.pendingRegistrationClaim,
      ctx.result.id,
      owner.surface.worktreeId,
      null,
      {
        tabId: owner.surface.tabId,
        leafId: owner.surface.leafId,
        terminalHandle: owner.surface.terminalHandle,
        ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
        ...(providerReattachLaunchIdentity ? { providerReattachLaunchIdentity } : {})
      }
    )
    if (rejectedRegistration) {
      await rejectedRegistration
    }
    // Why here: an adoption returns before the commit site below.
    ctx.deps.runtime?.noteTerminalSpawnCommit?.(
      ctx.result,
      ctx.hostSessionBinding?.expectedSourceBinding
    )
    ctx.deps.runtime?.registerPreAllocatedHandleForPty(ctx.result.id, owner.surface.terminalHandle)
    ctx.deps.options?.onCodexHomePtySpawned?.({
      id: ctx.result.id,
      codexHomePath: ctx.selectedCodexHomePath,
      reattached: true,
      startedAt: ctx.codexHomeLaunchStartedAt,
      startedSequence: ctx.codexHomeLaunchStartedSequence,
      ...codexReattachedHomeRouteField(ctx.reattachedCodexHomeRoutes, ctx.result.id, true),
      ...(ctx.env ? { launchEnv: ctx.env } : {})
    })
    // Why: this branch returns before the normal commit site; without this the cache keeps
    // whatever the caller requested.
    commitRuntimePtySize(ctx, adoptedResult)
    // Why: the adopted branch returns before the normal settle site, so the
    // reservation must be resolved here or every later spawn for this pane
    // awaits a promise that never settles.
    resolvePaneSpawnReservation(
      ctx.paneSpawnReservationKey,
      ctx.paneSpawnReservation,
      adoptedResult
    )
    return {
      id: ctx.result.id,
      ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
      agentSessionEnsure: ctx.result.agentSessionEnsure
    }
  }
  if (ctx.hostSessionBinding) {
    try {
      const { store, worktreeId, tabId, leafId, expectedSourceBinding, placement } =
        ctx.hostSessionBinding
      const binding = {
        worktreeId,
        tabId,
        leafId,
        ptyId: ctx.result.id,
        // The runtime wrote the pane before spawning; a pane gone by now was closed meanwhile.
        mayCreate: false,
        ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
        ...(ctx.cwd ? { startupCwd: ctx.cwd } : {}),
        ...(expectedSourceBinding ? { expectedSourceBinding } : {}),
        ...(placement ? { placement } : {}),
        origin: spawnCommitBindingOrigin(ctx.result, expectedSourceBinding)
      }
      const persisted = await persistFreshPaneBinding(
        store,
        binding,
        args.connectionId,
        args.paneSpawnOperation?.absentOwner
      )
      if (persisted === false) {
        throw new Error('terminal_split_source_not_found')
      }
    } catch (err) {
      console.error('[pty] failed to persist runtime PTY binding after spawn:', err)
      await discardUnpersistedPtySpawn(ctx.provider, ctx.result, ctx.deps.runtime)
      if (
        err instanceof PaneOwnerContentionError ||
        (err instanceof Error && err.message === 'terminal_split_source_not_found')
      ) {
        throw err
      }
      throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage(err)), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    }
  }
  if (args.worktreeId) {
    const rejectedRegistration = registerPersistedPtySpawn(
      ctx.deps.runtime,
      ctx.hostSessionBinding?.store ?? ctx.deps.store,
      ctx.pendingRegistrationClaim,
      ctx.result.id,
      args.worktreeId,
      null,
      // Why: thread validated pane identity so main can back a pending mobile create even if graph-sync stalls (#7587).
      typeof args.tabId === 'string' &&
        isValidTerminalTabId(args.tabId) &&
        args.tabId.length <= 512 &&
        ctx.metadataLeafId !== null
        ? {
            tabId: args.tabId,
            leafId: ctx.metadataLeafId,
            ...(args.preAllocatedHandle ? { terminalHandle: args.preAllocatedHandle } : {}),
            ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
            ...(providerReattachLaunchIdentity ? { providerReattachLaunchIdentity } : {})
          }
        : undefined,
      shouldSkipCodexHomeEnvForWindowsShell(ctx.daemonShellOverride, ctx.cwd)
    )
    if (rejectedRegistration) {
      await rejectedRegistration
    }
  } else {
    // Why: non-worktree PTYs have no later surface-registration phase to clear admission intent.
    ctx.deps.runtime?.cancelPendingPtyRegistration?.(
      ctx.result.id,
      ctx.result.incarnationId,
      ctx.pendingRegistrationClaim
    )
  }
  // Why after registration: a spawn discarded for a failed save or rejected for exiting during
  // start must not record facts or end a stop.
  ctx.deps.runtime?.noteTerminalSpawnCommit?.(
    ctx.result,
    ctx.hostSessionBinding?.expectedSourceBinding
  )
  if (args.preAllocatedHandle && !ctx.stablePaneOwner?.handle) {
    ctx.deps.runtime?.registerPreAllocatedHandleForPty(ctx.result.id, args.preAllocatedHandle)
  }

  commitRuntimePtySize(ctx, ctx.result)
  if (ctx.effectiveSessionAppId !== undefined && ctx.effectiveSessionAppId !== ctx.result.id) {
    ptySizes.delete(ctx.effectiveSessionAppId)
  }
  recordCodexPaneAccountForSpawn({
    ptyId: ctx.result.id,
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    isReattach: ctx.result.isReattach === true,
    pinnedByResume: ctx.codexResumeHomeSelected,
    launchCodexHomePath: ctx.selectedCodexHomePath,
    target: ctx.codexSelectionTarget,
    settings: ctx.deps.getSettings?.()
  })
  // Why: runtime-controller creates (headless serve, CLI, splits) adopt surviving daemon sessions too; without this seed their records stay blank.
  seedTerminalRestoreRecordsFromSpawnResult(ctx.deps.runtime, ctx.result)
  // Why: arms main's per-PTY Command Code output detector from the launch command (renderer startupCommand parity).
  if (!ctx.stablePaneOwner) {
    ctx.deps.runtime?.noteTerminalSpawnCommand?.(ctx.result.id, ctx.launchCommand ?? null)
  }
  if (args.telemetry && !ctx.stablePaneOwner) {
    recordPtySpawnTelemetry(args.telemetry)
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
  // Why after commit: a spawn rejected above must not leave a published identity behind.
  seedResumeLaunchIdentityFromSpawn({
    paneKey,
    launchAgent: args.launchAgent,
    resumeProviderSession: args.resumeProviderSession,
    connectionId: args.connectionId,
    worktreeId: args.worktreeId,
    launchedAt: ctx.codexHomeLaunchStartedAt,
    resumeArgvDropped: ctx.codexResumeArgvDropped,
    result: ctx.result
  })
  // Why: runtime-owned/background spawns bypass mounted-pane state, so inventory consumers need an explicit signal.
  ctx.deps.sendPtySpawnedToRenderer(ctx.result.id)
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
  return completeRuntimeSpawnResponse(ctx)
}

/** Runs inside the existing durable mutation, after source/topology checks and before any bind. */
export async function persistFreshPaneBinding(
  store: Store,
  binding: PersistPtyBindingArgs,
  connectionId?: string | null,
  absentOwner?: AbsentPaneBinding
): Promise<boolean> {
  let targetChanged = false
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const persisted = await store.persistPtyBinding(() => {
    const session = store.getWorkspaceSession(hostId)
    const paneKey = makePaneKey(binding.tabId, binding.leafId)
    if (ptyBindingIsRefused(binding, session, binding.worktreeId, paneKey, [])) {
      return binding
    }
    const bound = session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
    const stamp = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
    if (
      bound &&
      (bound !== binding.ptyId || stamp !== binding.incarnationId) &&
      !isAbsentBindingReplay(absentOwner, bound, stamp)
    ) {
      targetChanged = true
      return null
    }
    return binding
  }, hostId)
  if (targetChanged) {
    throw new PaneOwnerContentionError()
  }
  return persisted
}
