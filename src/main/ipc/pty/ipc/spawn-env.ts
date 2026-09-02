import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey
} from '../../../../shared/stable-pane-id'
import { isRemoteAgentHooksEnabled } from '../../../../shared/agent-hook-relay'
import { isOpaqueRemintedPaneKey } from '../../../../shared/pane-key-alias'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isClaudeAuthSwitchInProgress } from '../../../claude-accounts/live-pty-gate'
import { hasClaudeAuthEnvConflict } from '../../../claude-accounts/environment'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'
import { routesFreshSpawnsToLocalProvider } from '../host-env/fresh-spawn-routing'
import { stripRemotePaneEnvWhenHooksDisabled } from '../provider/liveness'
import { parseValidPaneKey } from '../pane/key-state'
import { shouldRefreshNativeClaudeAgentTeamsEnv } from '../pane/launch-authority'
import type { PtyIpcSpawnState } from './spawn-state'
import { assemblePtyIpcSpawnCodexEnv } from './spawn-env-codex'

export async function assemblePtyIpcSpawnEnv(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  if (ctx.isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
    throw new Error('A Claude account switch is in progress. Try again after it finishes.')
  }
  if (ctx.claudeAuth?.stripAuthEnv && hasClaudeAuthEnvConflict(args.env)) {
    throw new Error(
      'This Claude launch defines explicit Anthropic auth environment variables. Remove those overrides before using a managed Claude account.'
    )
  }
  // Why: the daemon-backed provider skips LocalPtyProvider's buildSpawnEnv, so assemble the same host-local env here for parity.
  // Safety: skip entirely for SSH — every injection is a loopback secret or a local path that leaks or misleads on the remote host.
  // Why: forward pane env to SSH only when the relay hook path is enabled, or a newer relay could emit statuses this build can't route.
  const sshSourceEnv = stripRemotePaneEnvWhenHooksDisabled(args.connectionId, args.env)
  const baseEnvWithAuth = ctx.claudeAuth
    ? { ...sshSourceEnv, ...ctx.claudeAuth.envPatch }
    : sshSourceEnv
  const spawnPaneKey = baseEnvWithAuth?.ORCA_PANE_KEY
  const parsedSpawnPaneKey = parseValidPaneKey(spawnPaneKey)
  const verifiedPaneKey =
    parsedSpawnPaneKey &&
    typeof args.tabId === 'string' &&
    args.tabId === parsedSpawnPaneKey.tabId &&
    args.leafId === parsedSpawnPaneKey.leafId
      ? makePaneKey(parsedSpawnPaneKey.tabId, parsedSpawnPaneKey.leafId)
      : null
  ctx.verifiedLeafId = verifiedPaneKey && parsedSpawnPaneKey ? parsedSpawnPaneKey.leafId : null
  ctx.metadataLeafId =
    typeof args.leafId === 'string' && isTerminalLeafId(args.leafId) ? args.leafId : null
  ctx.metadataPaneKey =
    typeof args.tabId === 'string' &&
    isValidTerminalTabId(args.tabId) &&
    args.tabId.length <= 512 &&
    ctx.metadataLeafId
      ? makePaneKey(args.tabId, ctx.metadataLeafId)
      : null
  ctx.legacySpawnPaneKey = verifiedPaneKey ? null : parseLegacyNumericPaneKey(spawnPaneKey)
  const normalizedSpawnPaneKey = spawnPaneKey?.trim() ?? ''
  ctx.opaqueRemintedSpawnPaneKey =
    verifiedPaneKey || !isOpaqueRemintedPaneKey(normalizedSpawnPaneKey)
      ? null
      : normalizedSpawnPaneKey
  ctx.migrationUnsupportedPaneKey =
    ctx.legacySpawnPaneKey &&
    typeof args.tabId === 'string' &&
    args.tabId === ctx.legacySpawnPaneKey.tabId &&
    typeof args.leafId === 'string' &&
    isTerminalLeafId(args.leafId)
      ? makePaneKey(args.tabId, args.leafId)
      : null
  ctx.stablePaneKey = verifiedPaneKey ?? ctx.migrationUnsupportedPaneKey ?? ctx.metadataPaneKey
  ctx.baseEnv = baseEnvWithAuth ? { ...baseEnvWithAuth } : undefined
  const shouldRefreshAgentTeamsEnv =
    !ctx.preAdoptedStablePane &&
    !args.connectionId &&
    ctx.deps.runtime !== undefined &&
    ctx.stablePaneKey !== null &&
    shouldRefreshNativeClaudeAgentTeamsEnv({
      command: args.command,
      launchConfig: args.launchConfig
    })
  ctx.effectiveLaunchConfig = args.launchConfig
  const shouldPreAllocateTerminalHandle =
    ctx.deps.runtime !== undefined &&
    ((!(ctx.provider instanceof LocalPtyProvider) &&
      !routesFreshSpawnsToLocalProvider(ctx.provider)) ||
      shouldRefreshAgentTeamsEnv)
  const runtime = ctx.deps.runtime
  ctx.preAllocatedHandle = shouldPreAllocateTerminalHandle
    ? (ctx.preAdoptedStablePane?.owner.handle ??
      runtime?.createPreAllocatedTerminalHandle() ??
      null)
    : null
  if (shouldRefreshAgentTeamsEnv && ctx.preAllocatedHandle && runtime) {
    // Why: Agent Teams ids/tokens are process-local, so the team env must be regenerated for the new leader PTY.
    const prepared = await runtime.prepareClaudeAgentTeamsLeaderForHandle({
      handle: ctx.preAllocatedHandle,
      baseEnv: ctx.baseEnv ?? {}
    })
    ctx.agentTeamsLeaderHandle = ctx.preAllocatedHandle
    ctx.baseEnv = {
      ...ctx.baseEnv,
      ...prepared.env
    }
    if (args.launchConfig) {
      ctx.effectiveLaunchConfig = {
        ...args.launchConfig,
        agentEnv: {
          ...args.launchConfig.agentEnv,
          ...prepared.env
        }
      }
    }
  }
  ctx.requestedAgentTeamsPath = ctx.baseEnv?.ORCA_AGENT_TEAMS_TEAM_ID
    ? ctx.baseEnv[resolvePathEnvKey(ctx.baseEnv, process.platform)]
    : undefined
  ctx.agentTeamsEnvToDelete = shouldRefreshAgentTeamsEnv ? ['TERM_PROGRAM'] : undefined
  const canForwardPaneEnv = !args.connectionId || isRemoteAgentHooksEnabled()
  if (ctx.baseEnv && ctx.stablePaneKey && canForwardPaneEnv) {
    ctx.baseEnv.ORCA_PANE_KEY = ctx.stablePaneKey
    if (typeof args.tabId === 'string') {
      ctx.baseEnv.ORCA_TAB_ID = args.tabId
    } else if (!args.connectionId) {
      delete ctx.baseEnv.ORCA_TAB_ID
    }
    if (typeof args.worktreeId === 'string') {
      ctx.baseEnv.ORCA_WORKTREE_ID = args.worktreeId
    } else if (!args.connectionId) {
      delete ctx.baseEnv.ORCA_WORKTREE_ID
    }
  } else if (ctx.baseEnv) {
    // Why: ORCA_PANE_KEY crosses into shells/hook registries; only a key proven to match this spawn's tab+leaf may cross the IPC boundary.
    delete ctx.baseEnv.ORCA_PANE_KEY
    delete ctx.baseEnv.ORCA_TAB_ID
    delete ctx.baseEnv.ORCA_WORKTREE_ID
    delete ctx.baseEnv.ORCA_AGENT_LAUNCH_TOKEN
  }
  ctx.validatedPaneKey = ctx.stablePaneKey
  // Why: SSH can strip ORCA_PANE_KEY when remote hooks are off; IPC tab/leaf metadata still names the pane.
  ctx.reservationPaneKey = ctx.metadataPaneKey ?? ctx.validatedPaneKey
  ctx.validatedLeafId = ctx.verifiedLeafId ?? ctx.metadataLeafId
  ctx.spawnTiming.mark('pane_env')
  await assemblePtyIpcSpawnCodexEnv(ctx)
}
