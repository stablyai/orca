import { isRestoreSpawnIntent } from '../../../../shared/host-spawn-admission'
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
    isNewSession: ctx.ownsNewIncarnation,
    codexRuntime: ctx.codexSelectionTarget.runtime,
    expectedWslDistro: ctx.expectedWslDistro,
    requestedAgentTeamsPath: ctx.requestedAgentTeamsPath,
    selectedCodexHomePath: ctx.selectedCodexHomePath,
    shellOverride: ctx.effectiveShellOverride,
    paneKey: ctx.reservationPaneKey,
    sessionId: ctx.effectiveSessionId,
    // Window callers may declare restore intents only; other intents belong to the host.
    spawnIntent: isRestoreSpawnIntent(args.spawnIntent) ? args.spawnIntent : undefined,
    getSettings: ctx.deps.getSettings,
    store: ctx.deps.store,
    claudeAuth: ctx.claudeAuth
  })
  ctx.spawnOptions = launch.spawnOptions
  ctx.spawnEnv = launch.env
  ctx.launchCommand = launch.launchCommand
  ctx.provisionalPtySize = seedPtySpawnSize({
    sessionId: ctx.effectiveSessionId,
    sessionAppId: ctx.effectiveSessionAppId,
    isFreshSessionId: ctx.ownsNewIncarnation,
    requestIsUnmeasured: args.initiallyHidden === true,
    cols: args.cols,
    rows: args.rows
  })
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
  // Mark daemon PTYs hidden before early output; renderer reset can still clear this attachment-owned mark after preflight.
  ctx.preSpawnHiddenMarkId =
    ctx.initiallyHidden && ctx.isDaemonHostSpawn && ctx.effectiveSessionAppId !== undefined
      ? ctx.effectiveSessionAppId
      : null
  if (ctx.preSpawnHiddenMarkId !== null) {
    ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, true)
  }
}
