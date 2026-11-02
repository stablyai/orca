import { PLUGIN_HOOK_SPECS } from '../../../shared/plugins/events/plugin-hook-payloads'
import { isRestoreSpawnIntent } from '../../../shared/host-spawn-admission'
import type { TuiAgent } from '../../../shared/tui-agent'
import { workspaceKindForWorktreeId } from '../../../shared/workspace-launch-kind'
import { pluginHookWanted, runPluginHook } from '../../plugins/hooks/plugin-hook-dispatch'

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
  args: Args
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
  const added = Object.keys(decided.env).length > 0
  return {
    ...args,
    command: decided.command,
    ...(added ? { env: { ...args.env, ...decided.env } } : {})
  }
}
