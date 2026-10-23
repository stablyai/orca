import type { IPtyProvider, PtySpawnResult } from '../../../providers/pty-provider-contract'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { makePaneKey, isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import {
  routesFreshSpawnsToLocalProvider,
  beginPtySpawnForWorktree
} from '../host-env/fresh-spawn-routing'
import { makePaneSpawnReservationKey } from '../pane/spawn-reservation'
import {
  assemblePtySpawnEnvDeletions,
  assemblePtySpawnLaunchOptions,
  seedPtySpawnSize
} from '../spawn-options-assembly'
import type { RuntimePtySpawnState } from './spawn-state'
import { prepareAntigravityAccountForLaunch } from '../../../antigravity/native-account-launch'

/** Host lane: the shared spawn options plus this lane's agent-session claims and pane join. */
export async function buildRuntimePtySpawnOptions(
  ctx: RuntimePtySpawnState
): Promise<
  (PtySpawnResult & { stablePaneOwner?: { handle: string; tabId: string; leafId: string } }) | null
> {
  const args = ctx.args
  const settings = ctx.deps.getSettings?.()
  // Host history is sampled before preparation; the window samples it afterwards.
  const historyIsolationEnabled = ctx.deps.getSettings?.()?.terminalScopeHistoryByWorktree ?? true
  let ptySpawnCommitReported = false
  ctx.reportPtySpawnCommitted = (): void => {
    if (ptySpawnCommitReported) {
      return
    }
    ptySpawnCommitReported = true
    args.onPtySpawnCommitted?.()
  }
  const deletions = assemblePtySpawnEnvDeletions({
    env: ctx.env,
    callerEnvToDelete: args.envToDelete,
    agentTeamsEnvToDelete: [],
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    connectionId: args.connectionId,
    skipCodexHomeEnv: ctx.skipCodexHomeEnv,
    stripInheritedOrcaCodexHome: ctx.stripInheritedOrcaCodexHome,
    codexResumeHomeSelected: ctx.codexResumeHomeSelected,
    settings
  })
  ctx.env = deletions.env
  await prepareAntigravityAccountForLaunch({
    launchAgent: args.launchAgent,
    command: ctx.launchCommand,
    connectionId: args.connectionId,
    isWsl: ctx.codexSelectionTarget.runtime === 'wsl',
    env: ctx.env,
    envToDelete: deletions.envToDelete
  })
  ctx.materializedPaneKey = ctx.hostSessionBinding
    ? makePaneKey(ctx.hostSessionBinding.tabId, ctx.hostSessionBinding.leafId)
    : null
  ctx.metadataLeafId =
    typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
  ctx.metadataPaneKey =
    typeof args.tabId === 'string' &&
    isValidTerminalTabId(args.tabId) &&
    args.tabId.length <= 512 &&
    ctx.metadataLeafId
      ? makePaneKey(args.tabId, ctx.metadataLeafId)
      : null
  ctx.spawnIdentityPaneKey = ctx.materializedPaneKey ?? ctx.metadataPaneKey
  const launch = await assemblePtySpawnLaunchOptions({
    args,
    env: ctx.env,
    envToDelete: deletions.envToDelete,
    launchCommand: ctx.launchCommand,
    cwd: ctx.cwd,
    prevalidatedCwd: ctx.prevalidatedCwd,
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    preAdoptedStablePane: ctx.preAdoptedStablePane !== null,
    isNewSession: ctx.isNewDaemonSession,
    codexRuntime: ctx.codexSelectionTarget.runtime,
    expectedWslDistro: ctx.expectedWslDistro,
    requestedAgentTeamsPath: ctx.requestedAgentTeamsPath,
    selectedCodexHomePath: ctx.selectedCodexHomePath,
    shellOverride: ctx.daemonShellOverride,
    paneKey: ctx.spawnIdentityPaneKey,
    sessionId: ctx.sessionId,
    spawnIntent: ctx.preAdoptedStablePane ? undefined : args.spawnIntent,
    historyIsolationEnabled,
    getSettings: ctx.deps.getSettings,
    store: ctx.deps.store,
    claudeAuth: ctx.claudeAuth
  })
  ctx.spawnOptions = launch.spawnOptions
  ctx.env = launch.env
  ctx.launchCommand = launch.launchCommand
  const seeded = seedPtySpawnSize({
    sessionId: ctx.sessionId,
    sessionAppId: ctx.effectiveSessionAppId,
    isFreshSessionId: ctx.isNewDaemonSession,
    // Why false: runtime callers (CLI, headless serve) have no hidden pane to report, so a
    // cached size is the only source that can outrank their requested grid here.
    requestIsUnmeasured: false,
    cols: args.cols,
    rows: args.rows
  })
  ctx.hadSessionSizeBeforeAttach = seeded.hadSessionSizeBeforeAttach
  ctx.sessionSizeBeforeAttach = seeded.sessionSizeBeforeAttach
  if (
    !ctx.preAdoptedStablePane &&
    args.agentSessionEnsure &&
    (await (ctx.provider as IPtyProvider).supportsAgentSessionClaims?.()) === false
  ) {
    // Why: runtime routing must select legacy before dispatch; never downgrade here after it began.
    throw new Error('agent_session_claim_unavailable')
  }
  if (
    !ctx.preAdoptedStablePane &&
    args.agentSessionCreateOperationId &&
    (await (ctx.provider as IPtyProvider).supportsAgentSessionCreateOperations?.()) === false
  ) {
    throw new Error('execution_owner_unavailable')
  }
  if (!ctx.preAdoptedStablePane && args.agentSessionEnsure) {
    ctx.spawnOptions.agentSessionEnsure = args.agentSessionEnsure
  }
  if (!ctx.preAdoptedStablePane && args.agentSessionCreateOperationId) {
    ctx.spawnOptions.agentSessionCreateOperationId = args.agentSessionCreateOperationId
  }
  if (args.signal) {
    ctx.spawnOptions.signal = args.signal
  }
  if (
    args.onPtySpawnCommitted &&
    (ctx.provider instanceof LocalPtyProvider || routesFreshSpawnsToLocalProvider(ctx.provider))
  ) {
    // Why: local fallback has no lower operation ledger, so commit must be reported at native spawn.
    ctx.spawnOptions.onPtySpawnCommitted = ctx.reportPtySpawnCommitted
  }

  const resolvedPaneSpawnReservationKey = makePaneSpawnReservationKey(
    args.worktreeId,
    args.connectionId,
    ctx.spawnIdentityPaneKey
  )
  if (
    ctx.paneSpawnReservationKey &&
    ctx.paneSpawnReservationKey !== resolvedPaneSpawnReservationKey
  ) {
    throw new Error('terminal_pane_identity_changed')
  }
  ctx.paneSpawnReservationKey = resolvedPaneSpawnReservationKey
  ctx.finishTerminalInstall = beginPtySpawnForWorktree(args.worktreeId, ctx.cwd, args.connectionId)
  ctx.stablePaneOwner = null
  ctx.stablePaneBindingPersisted = false
  ctx.rejectedRegistrationCandidate = null
  ctx.pendingRegistrationPtyId = null
  // Why hoisted to the reply scope: main reconciles the provider sequence
  // deep inside the spawn path, but the pane needs that renderer-domain
  // boundary beside the daemon snapshot's kitty flags.
  ctx.reconciledSnapshotSeq = null
  // False when bytes crossed the data socket during the spawn RPC: the
  // reconciled boundary covers them, but the daemon proved its kitty flags
  // before they existed, so the claim must not erase what the pane may
  // have scanned from those bytes live.
  ctx.snapshotKittyFlagsCoverReconciledSeq = true
  ctx.preparedProvisionalExecutionContext = false

  return null
}
