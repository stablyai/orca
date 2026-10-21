import { isRestoreSpawnIntent } from '../../../../shared/host-spawn-admission'
import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { beginPtySpawnForWorktree } from '../host-env/fresh-spawn-routing'
import { makePaneSpawnReservationKey } from '../pane/spawn-reservation'
import {
  assemblePtySpawnEnvDeletions,
  assemblePtySpawnLaunchOptions,
  seedPtySpawnSize
} from '../spawn-options-assembly'
import type { PtyIpcSpawnState } from './spawn-state'

/** Carries deletions to provider-owned environments, including persistent older daemons. */
export async function buildPtyIpcSpawnOptions(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  const settings = ctx.deps.getSettings?.()
  const deletions = assemblePtySpawnEnvDeletions({
    env: ctx.preAllocatedHandle
      ? { ...ctx.env, ORCA_TERMINAL_HANDLE: ctx.preAllocatedHandle }
      : ctx.env,
    callerEnvToDelete: args.envToDelete,
    agentTeamsEnvToDelete: ctx.agentTeamsEnvToDelete ?? [],
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    connectionId: args.connectionId,
    skipCodexHomeEnv: ctx.skipCodexHomeEnv,
    stripInheritedOrcaCodexHome: ctx.stripInheritedOrcaCodexHome,
    codexResumeHomeSelected: ctx.codexResumeHomeSelected,
    settings
  })
  ctx.combinedEnvToDelete = deletions.envToDelete
  const launch = await assemblePtySpawnLaunchOptions({
    args,
    env: deletions.env,
    envToDelete: ctx.combinedEnvToDelete,
    launchCommand: ctx.launchCommand,
    cwd: ctx.cwd,
    prevalidatedCwd: ctx.prevalidatedCwd,
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    preAdoptedStablePane: ctx.preAdoptedStablePane !== null,
    isNewSession: ctx.isMintedSessionId,
    codexRuntime: ctx.codexSelectionTarget.runtime,
    expectedWslDistro: ctx.expectedWslDistro,
    requestedAgentTeamsPath: ctx.requestedAgentTeamsPath,
    selectedCodexHomePath: ctx.selectedCodexHomePath,
    shellOverride: ctx.effectiveShellOverride,
    paneKey: ctx.reservationPaneKey,
    sessionId: ctx.effectiveSessionId,
    // Why: the window admits only restore intents; other intents are host-declared.
    spawnIntent: isRestoreSpawnIntent(args.spawnIntent) ? args.spawnIntent : undefined,
    getSettings: ctx.deps.getSettings,
    store: ctx.deps.store,
    claudeAuth: ctx.claudeAuth
  })
  ctx.spawnOptions = launch.spawnOptions
  ctx.spawnEnv = launch.env
  ctx.launchCommand = launch.launchCommand
  const seeded = seedPtySpawnSize({
    sessionId: ctx.effectiveSessionId,
    sessionAppId: ctx.effectiveSessionAppId,
    isFreshSessionId: ctx.isMintedSessionId,
    requestIsUnmeasured: args.initiallyHidden === true,
    cols: args.cols,
    rows: args.rows
  })
  ctx.hadSessionSizeBeforeAttach = seeded.hadSessionSizeBeforeAttach
  ctx.sessionSizeBeforeAttach = seeded.sessionSizeBeforeAttach
  const resolvedPaneSpawnReservationKey = makePaneSpawnReservationKey(
    args.worktreeId,
    args.connectionId,
    ctx.reservationPaneKey
  )
  if (
    ctx.paneSpawnReservationKey &&
    resolvedPaneSpawnReservationKey !== ctx.paneSpawnReservationKey
  ) {
    throw new Error('terminal_pane_identity_changed')
  }
  ctx.paneSpawnReservationKey = resolvedPaneSpawnReservationKey
  ctx.finishTerminalInstall = beginPtySpawnForWorktree(args.worktreeId, ctx.cwd, args.connectionId)
  ctx.initiallyHidden = args.initiallyHidden === true
  // Why: daemon PTYs can emit before spawn() resolves, so the hidden mark must beat byte zero (terminal-query-authority.md §races); other providers are safe with the post-spawn mark below.
  // TEMPORARY (C5e): absent-owner cleanup clears the early mark before replacement spawn.
  ctx.preSpawnHiddenMarkId =
    ctx.initiallyHidden && ctx.isDaemonHostSpawn && ctx.effectiveSessionAppId !== undefined
      ? ctx.effectiveSessionAppId
      : null
  if (ctx.preSpawnHiddenMarkId !== null) {
    ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, true)
  }
  const runtime = ctx.deps.runtime
  const acquireWorktreeSpawn = runtime?.acquireWorktreeTerminalSpawn
  ctx.releaseWorktreeSpawn = acquireWorktreeSpawn
    ? await acquireWorktreeSpawn.call(
        runtime,
        spawnWorktreeTarget(args.worktreeId, args.connectionId)
      )
    : undefined
}
