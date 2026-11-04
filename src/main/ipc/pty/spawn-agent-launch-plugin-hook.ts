import { PLUGIN_HOOK_SPECS } from '../../../shared/plugins/events/plugin-hook-payloads'
import { isRestoreSpawnIntent } from '../../../shared/host-spawn-admission'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { workspaceKindForWorktreeId } from '../../../shared/workspace-launch-kind'
import { pluginHookWanted, runPluginHook } from '../../plugins/hooks/plugin-hook-dispatch'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../ai-vault/structured-session-ownership'
import { addWslEnvKeys } from '../../../shared/wsl-env'

type AgentSpawnArgs = {
  launchAgent?: TuiAgent
  command?: string
  env?: Record<string, string>
  worktreeId?: string
  preAllocatedHandle?: string
  spawnIntent?: unknown
  resumeOrigin?: unknown
  resumeProviderSession?: unknown
}

/**
 * `agent.launch.before` at the one place every agent terminal starts (window, runtime, CLI,
 * automation, orchestration), before the spawn goes to its host, so SSH, WSL and daemon terminals
 * are decided on this Orca. Restores and resumes are not launches. Throws PluginHookDeniedError.
 */
export async function applyAgentLaunchPluginHook<Args extends AgentSpawnArgs>(
  args: Args,
  runtime: { ensureStructuredAgentSessionHost(): Promise<void> } | undefined
): Promise<Args> {
  const { launchAgent, command } = args
  if (
    !launchAgent ||
    !command ||
    isRestoreSpawnIntent(args.spawnIntent) ||
    args.resumeOrigin !== undefined ||
    args.resumeProviderSession !== undefined ||
    !pluginHookWanted('agent.launch.before')
  ) {
    return args
  }
  const kind = args.worktreeId ? workspaceKindForWorktreeId(args.worktreeId) : null
  const decided = await runPluginHook(
    'agent.launch.before',
    PLUGIN_HOOK_SPECS['agent.launch.before'].payload,
    {
      agent: launchAgent,
      workspaceId: kind && kind !== 'floating' ? (args.worktreeId ?? null) : null,
      workspaceKind: kind === 'folder' ? 'folder' : kind === 'git-worktree' ? 'worktree' : null,
      ...(args.preAllocatedHandle ? { terminalId: args.preAllocatedHandle } : {}),
      command,
      env: {}
    }
  )
  if (decided.command !== command) {
    // The caller checked its own command; a plugin's must not resume a chat-owned session either.
    await assertLegacyAiVaultResumeCommandAllowed(
      decided.command,
      () => runtime?.ensureStructuredAgentSessionHost() ?? Promise.resolve()
    )
  }
  const addedKeys = Object.keys(decided.env)
  const env = addedKeys.length > 0 ? { ...args.env, ...decided.env } : undefined
  if (env && process.platform === 'win32') {
    // wsl.exe imports only the variables WSLENV names.
    addWslEnvKeys(env, addedKeys)
  }
  return { ...args, command: decided.command, ...(env ? { env } : {}) }
}
