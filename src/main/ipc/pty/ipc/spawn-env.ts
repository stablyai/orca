import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey
} from '../../../../shared/stable-pane-id'
import { isOpaqueRemintedPaneKey } from '../../../../shared/pane-key-alias'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'
import { routesFreshSpawnsToLocalProvider } from '../host-env/fresh-spawn-routing'
import { parseValidPaneKey } from '../pane/key-state'
import { shouldRefreshNativeClaudeAgentTeamsEnv } from '../pane/launch-authority'
import { selectWindowJcodeRuntimeDir, stampPtySpawnPaneEnv } from '../spawn-pane-env'
import type { PtyIpcSpawnState } from './spawn-state'
import { assemblePtyIpcSpawnCodexEnv } from './spawn-env-codex'
import { prepareAntigravityAccountForLaunch } from '../../../antigravity/native-account-launch'

export async function assemblePtyIpcSpawnEnv(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  // Why: the daemon-backed provider skips LocalPtyProvider's buildSpawnEnv, so assemble the same host-local env here for parity.
  const baseEnvWithAuth = ctx.claudeAuth ? { ...args.env, ...ctx.claudeAuth.envPatch } : args.env
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
  stampPtySpawnPaneEnv(ctx.baseEnv, {
    // Why: the renderer-sent key only picks commit bookkeeping; the env names the spawn's own tab+leaf.
    pane: ctx.stablePaneKey
      ? {
          paneKey: ctx.stablePaneKey,
          tabId: typeof args.tabId === 'string' ? args.tabId : undefined,
          worktreeId: typeof args.worktreeId === 'string' ? args.worktreeId : undefined
        }
      : null,
    jcodeRuntimeDir:
      ctx.baseEnv && ctx.stablePaneKey
        ? selectWindowJcodeRuntimeDir(ctx.stablePaneKey, ctx.isDaemonHostSpawn)
        : undefined
  })
  ctx.validatedPaneKey = ctx.stablePaneKey
  // Why: IPC tab/leaf metadata names the pane even when ORCA_PANE_KEY was not proven.
  ctx.reservationPaneKey = ctx.metadataPaneKey ?? ctx.validatedPaneKey
  ctx.validatedLeafId = ctx.verifiedLeafId ?? ctx.metadataLeafId
  ctx.spawnTiming.mark('pane_env')
  await assemblePtyIpcSpawnCodexEnv(ctx)
  await prepareAntigravityAccountForLaunch({
    launchAgent: args.launchAgent,
    command: args.command ?? args.launchConfig?.agentCommand,
    connectionId: args.connectionId,
    isWsl: ctx.codexSelectionTarget.runtime === 'wsl',
    env: ctx.spawnEnv ?? ctx.baseEnv,
    envToDelete: args.envToDelete
  })
}
