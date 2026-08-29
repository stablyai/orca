import type { IPtyProvider, PtySpawnResult } from '../../../providers/types'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { makePaneKey, isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { ptySizes } from '../delivery/visibility-state'
import { CODEX_HOME_ENV_KEYS } from '../host-env/codex-home'
import {
  mergePtyEnvDeletions,
  removeCodexHomeDeletionRequests,
  getInheritedAgentHookEnvKeysToDelete,
  getInheritedClaudeSessionStampEnvKeysToDelete
} from '../host-env/pi-agent'
import { promoteAgentTeamsShimPath, deleteRequestedEnvKeys } from '../host-env/path'
import {
  routesFreshSpawnsToLocalProvider,
  beginPtySpawnForWorktree
} from '../host-env/fresh-spawn-routing'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { CLAUDE_AUTH_ENV_VARS } from '../../../claude-accounts/environment'
import { LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS } from '../../../pty/legacy-terminal-shim-dir'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import { getStartupTerminalColorQueryReplyColors } from '../../terminal-startup-color-query-replies'
import {
  makePaneSpawnReservationKey,
  reservePaneSpawn,
  paneSpawnReservationsByOwnerKey
} from '../pane/spawn-reservation'
import type { RuntimePtySpawnState } from './spawn-state'

export async function buildRuntimePtySpawnOptions(
  ctx: RuntimePtySpawnState
): Promise<
  (PtySpawnResult & { stablePaneOwner?: { handle: string; tabId: string; leafId: string } }) | null
> {
  const args = ctx.args

  const authEnvToDelete = ctx.claudeAuth?.stripAuthEnv
    ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS']
    : undefined
  ctx.spawnOptions = {
    cols: args.cols,
    rows: args.rows,
    cwd: ctx.cwd,
    env: ctx.env,
    historyIsolationEnabled: ctx.deps.getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
    ...(ctx.isNewDaemonSession ? { isNewSession: true } : {})
  }
  if (!args.connectionId && !ctx.isDaemonHostSpawn) {
    ctx.spawnOptions.codexHomePathOverride = { value: ctx.selectedCodexHomePath }
  }
  const startupTerminalColorQueryReplyColors = getStartupTerminalColorQueryReplyColors(args)
  if (startupTerminalColorQueryReplyColors) {
    ctx.spawnOptions.startupIngress = {
      colors: startupTerminalColorQueryReplyColors,
      deadlineMs: 5_000
    }
  }
  let ptySpawnCommitReported = false
  ctx.reportPtySpawnCommitted = (): void => {
    if (ptySpawnCommitReported) {
      return
    }
    ptySpawnCommitReported = true
    args.onPtySpawnCommitted?.()
  }
  ctx.spawnOptions.envToDelete = mergePtyEnvDeletions(
    authEnvToDelete,
    args.envToDelete ?? [],
    // Why: disable old hosts without removing ORCA_REAL_* while their Windows shim remains on PATH.
    ctx.isDaemonHostSpawn || args.connectionId ? LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS : [],
    ctx.isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(ctx.env) : [],
    // Why: ungated, unlike the agent-hook keys — the local provider and the relay host also spread their own process.env into every spawn.
    getInheritedClaudeSessionStampEnvKeysToDelete(ctx.env)
  )
  if (ctx.skipCodexHomeEnv) {
    ctx.spawnOptions.envToDelete = mergePtyEnvDeletions(
      ctx.spawnOptions.envToDelete,
      CODEX_HOME_ENV_KEYS
    )
  } else if (ctx.stripInheritedOrcaCodexHome) {
    // Why: the daemon owns a persistent inherited environment that may
    // differ from main. ORCA_CODEX_HOME asks it to compare/delete the pair.
    ctx.spawnOptions.envToDelete = mergePtyEnvDeletions(ctx.spawnOptions.envToDelete, [
      'ORCA_CODEX_HOME'
    ])
  }
  if (ctx.codexResumeHomeSelected) {
    ctx.spawnOptions.envToDelete = removeCodexHomeDeletionRequests(ctx.spawnOptions.envToDelete)
  }
  deleteRequestedEnvKeys(ctx.env, ctx.spawnOptions.envToDelete)
  promoteAgentTeamsShimPath(ctx.env, ctx.requestedAgentTeamsPath)
  if (ctx.launchCommand !== undefined) {
    ctx.spawnOptions.command = ctx.launchCommand
  }
  if (args.commandDelivery !== undefined) {
    ctx.spawnOptions.commandDelivery = args.commandDelivery
  }
  if (args.startupCommandDelivery !== undefined) {
    ctx.spawnOptions.startupCommandDelivery = args.startupCommandDelivery
  }
  if (isTuiAgent(args.launchAgent)) {
    ctx.spawnOptions.launchAgent = args.launchAgent
  }
  if (args.worktreeId !== undefined) {
    ctx.spawnOptions.worktreeId = args.worktreeId
  }
  ctx.hadSessionSizeBeforeAttach =
    ctx.effectiveSessionAppId !== undefined ? ptySizes.has(ctx.effectiveSessionAppId) : false
  ctx.sessionSizeBeforeAttach =
    ctx.effectiveSessionAppId !== undefined ? ptySizes.get(ctx.effectiveSessionAppId) : undefined
  if (ctx.sessionId !== undefined) {
    ctx.spawnOptions.sessionId = ctx.sessionId
    ptySizes.set(ctx.effectiveSessionAppId ?? ctx.sessionId, { cols: args.cols, rows: args.rows })
  }
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
  if (ctx.spawnIdentityPaneKey) {
    ctx.spawnOptions.paneKey = ctx.spawnIdentityPaneKey
  }
  if (typeof args.tabId === 'string' && args.tabId.length > 0 && args.tabId.length <= 512) {
    ctx.spawnOptions.tabId = args.tabId
  }
  if (process.platform === 'win32' && !args.connectionId) {
    ctx.spawnOptions.shellOverride = ctx.terminalRuntimeOptions.shellOverride
    ctx.spawnOptions.terminalWindowsWslDistro = ctx.expectedWslDistro
    ctx.spawnOptions.terminalWindowsPowerShellImplementation = ctx.deps.getSettings
      ? (ctx.deps.getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
      : undefined
  }
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
  if (!ctx.paneSpawnReservationKey) {
    ctx.paneSpawnReservationKey = resolvedPaneSpawnReservationKey
    const existingPaneSpawn = ctx.spawnIdentityPaneKey
      ? paneSpawnReservationsByOwnerKey.get(resolvedPaneSpawnReservationKey!)
      : undefined
    if (existingPaneSpawn) {
      const concurrentResult = await existingPaneSpawn.promise
      const concurrentOwner = resolveStablePaneOwner(
        ctx.deps.runtime,
        ctx.deps.store,
        ctx.spawnIdentityPaneKey,
        args.worktreeId,
        args.connectionId
      )
      if (
        !concurrentOwner?.handle ||
        concurrentOwner.ptyId !== concurrentResult.id ||
        (concurrentOwner.incarnationId !== undefined &&
          concurrentResult.incarnationId !== undefined &&
          concurrentOwner.incarnationId !== concurrentResult.incarnationId)
      ) {
        throw new Error('terminal_pane_owner_unknown')
      }
      const reattach = {
        id: concurrentOwner.ptyId,
        ...(concurrentOwner.incarnationId ? { incarnationId: concurrentOwner.incarnationId } : {}),
        stablePaneOwner: {
          handle: concurrentOwner.handle,
          tabId: concurrentOwner.tabId,
          leafId: concurrentOwner.leafId
        }
      }
      // Why: the winner owns its id's size; only a distinct losing session id remains provisional.
      if (ctx.sessionId !== undefined) {
        const provisionalSizeKey = ctx.effectiveSessionAppId ?? ctx.sessionId
        if (provisionalSizeKey !== reattach.id) {
          if (ctx.hadSessionSizeBeforeAttach && ctx.sessionSizeBeforeAttach) {
            ptySizes.set(provisionalSizeKey, ctx.sessionSizeBeforeAttach)
          } else {
            ptySizes.delete(provisionalSizeKey)
          }
        }
      }
      return reattach
    }
  }
  ctx.finishTerminalInstall = beginPtySpawnForWorktree(args.worktreeId, ctx.cwd, args.connectionId)
  ctx.paneSpawnReservation ??= ctx.paneSpawnReservationKey
    ? reservePaneSpawn(ctx.paneSpawnReservationKey)
    : null
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
