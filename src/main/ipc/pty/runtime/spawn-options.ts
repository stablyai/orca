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
import { isRuntimeWslBackgroundStart, type RuntimePtySpawnState } from './spawn-state'
import { prepareAntigravityAccountForLaunch } from '../../../antigravity/native-account-launch'

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
    isNewSession: ctx.ownsNewIncarnation,
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
  ctx.provisionalPtySize = seedPtySpawnSize({
    sessionId: ctx.sessionId,
    sessionAppId: ctx.effectiveSessionAppId,
    isFreshSessionId: ctx.ownsNewIncarnation,
    // Host requests, including defaults, are intentional; only a live cached grid outranks them.
    requestIsUnmeasured: false,
    cols: args.cols,
    rows: args.rows
  })
  if (
    !ctx.preAdoptedStablePane &&
    args.agentSessionEnsure &&
    (await (ctx.provider as IPtyProvider).supportsAgentSessionClaims?.()) === false
  ) {
    // Select legacy routing before dispatch; never downgrade after work begins.
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
  if (isRuntimeWslBackgroundStart(ctx)) {
    ctx.spawnOptions.wslBackgroundStart = true
  }
  if (ctx.wslHoldReadAnchor !== undefined) {
    ctx.spawnOptions.wslHoldReadAnchor = ctx.wslHoldReadAnchor
  }
  if (
    args.onPtySpawnCommitted &&
    (ctx.provider instanceof LocalPtyProvider || routesFreshSpawnsToLocalProvider(ctx.provider))
  ) {
    // Local fallback lacks an operation ledger; report commit at native spawn.
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
  ctx.provedSnapshotSeq = undefined
  ctx.preparedProvisionalExecutionContext = false

  return null
}
