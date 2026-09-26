import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { agentHookServer } from '../../../agent-hooks/server'
import { markClaudePtySpawnedForAuth } from '../claude-pinned-spawn'
import { registerPty } from '../../../memory/pty-registry'
import type { PtySpawnResult } from '../../../providers/types'
import { clearMigrationUnsupportedPtysForPaneKey } from '../../../agent-hooks/migration-unsupported-pty-state'
import { recordPtySpawnTelemetry } from '../pane/spawn-telemetry'
import {
  shouldSkipCodexHomeEnvForWindowsShell,
  codexReattachedHomeRouteField
} from '../host-env/codex-home'
import { rememberPaneKeyForPty } from '../pane/key-state'
import { resolvePaneSpawnReservation } from '../pane/spawn-reservation'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../pane/agent-session-owners'
import {
  admitProviderReattachLaunchIdentity,
  admitRendererAgentLaunchAuthority
} from '../pane/launch-authority'
import type { PtyIpcSpawnState } from './spawn-state'
import { persistPtyIpcSpawnCommit, publishPtyIpcSpawnCommit } from './spawn-commit-persist'
import { admitPtyReattachOwnership, registerPersistedPtySpawn } from '../pane/spawn-registration'
import { reflowHeadlessTerminalToCommittedGrid } from '../delivery/attached-pty-size'
import { seedHeadlessTerminalFromSpawnResult } from '../pane/terminal-spawn-restore'
import { markNativeWindowsConptyPty } from '../../../runtime/terminal-model-query-authority'

export async function commitPtyIpcSpawn(ctx: PtyIpcSpawnState): Promise<PtySpawnResult> {
  const args = ctx.args
  // Why first: the run's finally releases a pinned reservation, so a later commit step that throws
  // must not leave this live PTY unregistered; a failed persist's cleanup marks it exited again.
  if (ctx.isClaudeLaunch && !ctx.stablePaneOwner) {
    markClaudePtySpawnedForAuth(ctx.result.id, ctx.claudeAuth)
  }
  admitPtyReattachOwnership(ctx.deps.runtime, ctx.result, args.connectionId)
  if (ctx.nativeWindowsConptySpawn) {
    markNativeWindowsConptyPty(ctx.result.id)
  }
  // Seed before the first disk await so live output appends to the restored history.
  seedHeadlessTerminalFromSpawnResult(ctx.deps.runtime, ctx.result, ctx.validatedPaneKey)
  seedTerminalRestoreRecordsFromSpawnResult(ctx.deps.runtime, ctx.result)
  const committedSize = await persistPtyIpcSpawnCommit(ctx)
  if (
    typeof args.worktreeId === 'string' &&
    args.worktreeId.length > 0 &&
    args.worktreeId.length <= 512
  ) {
    const agentLaunchAuthority = admitRendererAgentLaunchAuthority({
      launchToken: args.launchToken,
      spawnEnv: ctx.spawnEnv,
      launchAgent: args.launchAgent,
      launchConfig: ctx.effectiveLaunchConfig,
      isReattach: ctx.result.isReattach === true,
      hasStablePaneOwner: ctx.stablePaneOwner !== null,
      incarnationId: ctx.result.incarnationId
    })
    const providerReattachLaunchIdentity = admitProviderReattachLaunchIdentity({
      isReattach: ctx.result.isReattach === true,
      launchAgent: ctx.result.launchAgent,
      incarnationId: ctx.result.incarnationId
    })
    const rejectedRegistration = registerPersistedPtySpawn(
      ctx.deps.runtime,
      ctx.deps.store,
      ctx.result.id,
      args.worktreeId,
      args.connectionId ?? null,
      // Why: pass validated pane identity so a throttled mobile create publishes its surface main-side instead of destroying the live PTY (#7587); bound the untrusted tabId.
      typeof args.tabId === 'string' &&
        isValidTerminalTabId(args.tabId) &&
        args.tabId.length <= 512 &&
        ctx.metadataLeafId !== null
        ? {
            tabId: args.tabId,
            leafId: ctx.metadataLeafId,
            ...(ctx.preAllocatedHandle ? { terminalHandle: ctx.preAllocatedHandle } : {}),
            ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
            ...(agentLaunchAuthority ? { agentLaunchAuthority } : {}),
            ...(providerReattachLaunchIdentity ? { providerReattachLaunchIdentity } : {})
          }
        : undefined,
      !args.connectionId
        ? shouldSkipCodexHomeEnvForWindowsShell(ctx.effectiveShellOverride, ctx.cwd)
        : undefined
    )
    if (rejectedRegistration) {
      await rejectedRegistration.catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'agent_session_exited_during_start') {
          throw error
        }
      })
      ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.result.id, ctx.result.incarnationId)
      ctx.pendingRegistrationPtyId = null
      // The renderer drains this incarnation's buffered output and exit without publishing it live.
      return resolvePaneSpawnReservation(
        ctx.paneSpawnReservationKey,
        ctx.paneSpawnReservation,
        ctx.result
      )
    }
    ctx.pendingRegistrationPtyId = null
  } else if (ctx.pendingRegistrationPtyId) {
    ctx.deps.runtime?.cancelPendingPtyRegistration?.(
      ctx.pendingRegistrationPtyId,
      ctx.result.incarnationId
    )
    ctx.pendingRegistrationPtyId = null
  }
  publishPtyIpcSpawnCommit(ctx, committedSize)
  // Admission must precede reflow: a replaced spawn cannot resize its successor's model.
  reflowHeadlessTerminalToCommittedGrid({
    result: ctx.result,
    committedSize,
    reflowHeadlessTerminalToPtyGrid: ctx.deps.runtime?.reflowHeadlessTerminalToPtyGrid?.bind(
      ctx.deps.runtime
    )
  })
  // Why: seed after registerPty binds the worktree — including on
  // desktop, where the renderer-authority gate above skips the emulator
  // seed but the list/read records still live main-side.
  seedTerminalRestoreRecordsFromSpawnResult(ctx.deps.runtime, ctx.result)
  // Why: arm main's per-PTY Command Code output detector from the launch command (startupCommand parity); banner detection covers PTYs without one.
  if (!ctx.stablePaneOwner) {
    ctx.deps.runtime?.noteTerminalSpawnCommand?.(
      ctx.result.id,
      typeof ctx.launchCommand === 'string' ? ctx.launchCommand : null
    )
  }
  // Why: record the paneKey mapping so clearProviderPtyState can clear the agent-hooks server's per-paneKey caches on exit.
  // Why: args.env is untrusted IPC JSON (type unenforced); bound the paneKey so malformed/oversized values can't pollute ptyPaneKey or clearPaneState.
  const rememberedPaneKey = ctx.validatedPaneKey
    ? rememberPaneKeyForPty(ctx.result.id, ctx.validatedPaneKey)
    : null
  if (ctx.legacySpawnPaneKey && ctx.migrationUnsupportedPaneKey) {
    agentHookServer.registerPaneKeyAlias(
      ctx.legacySpawnPaneKey.paneKey,
      ctx.migrationUnsupportedPaneKey,
      ctx.result.id,
      Date.now(),
      { authorityVerified: true }
    )
    clearMigrationUnsupportedPtysForPaneKey(ctx.migrationUnsupportedPaneKey)
  } else if (ctx.opaqueRemintedSpawnPaneKey && ctx.validatedPaneKey) {
    // Reminted $$ tokens are spawn-physical; alias them to the metadata-proven tab:leaf key.
    agentHookServer.registerPaneKeyAlias(
      ctx.opaqueRemintedSpawnPaneKey,
      ctx.validatedPaneKey,
      ctx.result.id,
      Date.now(),
      { authorityVerified: true }
    )
  } else if (ctx.validatedPaneKey) {
    if (!ctx.result.isReattach) {
      clearMigrationUnsupportedPtysForPaneKey(ctx.validatedPaneKey)
    }
  }
  // Why: register only local PTYs with the memory collector — SSH PTYs run remotely and their process tree is invisible to our local `ps`.
  if (!args.connectionId) {
    // Why: record the spawn-result pid once here so the memory module needn't reach back into ipc/pty on a hot path (works for in-process and daemon-hosted PTYs).
    const spawnedPid = ctx.result.pid ?? null
    // Why: args.worktreeId/sessionId arrive as untrusted IPC strings (type unenforced at the boundary); bound them so malformed/oversized values can't pollute registerPty's maps.
    registerPty({
      ptyId: ctx.result.id,
      worktreeId:
        typeof args.worktreeId === 'string' &&
        args.worktreeId.length > 0 &&
        args.worktreeId.length <= 512
          ? args.worktreeId
          : null,
      sessionId:
        typeof args.sessionId === 'string' &&
        args.sessionId.length > 0 &&
        args.sessionId.length <= 256
          ? args.sessionId
          : null,
      paneKey: rememberedPaneKey,
      pid:
        typeof spawnedPid === 'number' && Number.isFinite(spawnedPid) && spawnedPid > 0
          ? spawnedPid
          : null
    })
  }
  // Why: telemetry-plan.md§Agent launch semantics — fire agent_started only after spawn resolved; safeParse each field so a spoofed IPC payload can't poison the event (missing required field skips it).
  if (args.telemetry && !ctx.stablePaneOwner) {
    recordPtySpawnTelemetry(args.telemetry)
  }
  const response = {
    ...ctx.result,
    // Why both or neither: a pane can only adopt proven kitty flags together
    // with the sequence boundary they describe.
    ...(typeof ctx.result.snapshotKittyKeyboardFlags === 'number' &&
    ctx.reconciledSnapshotSeq !== null &&
    ctx.snapshotKittyFlagsCoverReconciledSeq
      ? { snapshotSeq: ctx.reconciledSnapshotSeq }
      : { snapshotKittyKeyboardFlags: undefined }),
    ...(!ctx.result.isReattach && ctx.effectiveLaunchConfig
      ? { launchConfig: ctx.effectiveLaunchConfig }
      : {}),
    // Why: a daemon-retry race can surface isReattach even for a minted session id, and a reattach must never claim its cwd was remapped.
    ...(ctx.startupCwdFallback && !ctx.result.isReattach
      ? { startupCwdFallback: ctx.startupCwdFallback }
      : {}),
    // Why: the pane asked to resume and got a fresh session instead; only the
    // renderer can say so, and a reattach never ran this launch command.
    ...(ctx.codexResumeLaunch.notifyResumeUnavailable && !ctx.result.isReattach
      ? { agentResumeUnavailable: true as const }
      : {})
  }
  // Why: renderer tab state cannot reliably infer background and reattached PTYs in the daemon inventory.
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
        : ctx.baseEnv
          ? { launchEnv: ctx.baseEnv }
          : {})
    })
  }
  return resolvePaneSpawnReservation(
    ctx.paneSpawnReservationKey,
    ctx.paneSpawnReservation,
    response
  )
}
