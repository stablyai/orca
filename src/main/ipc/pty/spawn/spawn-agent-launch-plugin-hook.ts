import { PLUGIN_HOOK_SPECS } from '../../../../shared/plugins/events/plugin-hook-payloads'
import {
  hookEntryRunsFor,
  type AgentLaunchKind,
  type PluginHookContribution
} from '../../../../shared/plugins/contributions/plugin-hook-contribution'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { workspaceKindForWorktreeId } from '../../../../shared/agent-launch/contracts/workspace-launch-kind'
import { pluginHookWanted, runPluginHook } from '../../../plugins/hooks/plugin-hook-dispatch'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-sessions/structured-session-ownership'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'
import { getProvider } from '../provider/registry'

type AgentSpawnArgs = {
  launchAgent?: TuiAgent
  command?: string
  env?: Record<string, string>
  worktreeId?: string
  preAllocatedHandle?: string
  spawnIntent?: unknown
  resumeOrigin?: unknown
  resumeProviderSession?: unknown
  sessionId?: string
  connectionId?: string | null
}

/** `restore` = a session Orca saved for this pane (`resumeOrigin: 'saved'`, or an automatic restore);
 *  `resume` = any other start of an earlier session. Not `spawnIntent` alone: `user-resume` is also an
 *  admission priority, sent for every pane visible when it restores. */
function launchKindOf(args: AgentSpawnArgs): AgentLaunchKind {
  if (args.resumeOrigin === 'saved' || args.spawnIntent === 'automatic-restore') {
    return 'restore'
  }
  return args.spawnIntent === 'user-resume' ||
    args.resumeOrigin !== undefined ||
    args.resumeProviderSession !== undefined
    ? 'resume'
    : 'new'
}

/** A resume or restore naming a session its host still runs only reattaches: no process starts. An
 *  unanswered probe (no provider for the host, or no probe) counts as a start. */
async function reattachesLiveSession(args: AgentSpawnArgs): Promise<boolean> {
  if (!args.sessionId) {
    return false
  }
  try {
    const provider = getProvider(getConnectionExecutionHostId(args.connectionId))
    return (await provider.probePtyLiveness?.(args.sessionId)) === true
  } catch {
    return false
  }
}

/**
 * `agent.launch.before` at the one place every agent terminal starts (window, runtime, CLI,
 * automation, orchestration), before the spawn goes to its host, so SSH, WSL and daemon terminals
 * are decided on this Orca. Resumes and restores wait only on plugins that opted into them, are
 * skipped when they only reattach, and keep Orca's own command. Throws PluginHookDeniedError.
 */
export async function applyAgentLaunchPluginHook<Args extends AgentSpawnArgs>(
  args: Args,
  runtime: { ensureStructuredAgentSessionHost(): Promise<void> } | undefined
): Promise<Args> {
  const { launchAgent, command } = args
  const launchKind = launchKindOf(args)
  const match = (hook: PluginHookContribution): boolean =>
    hookEntryRunsFor(hook, 'agent.launch.before', { launchKind })
  if (!launchAgent || !command || !pluginHookWanted('agent.launch.before', match)) {
    return args
  }
  if (launchKind !== 'new' && (await reattachesLiveSession(args))) {
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
      launchKind,
      env: {}
    },
    match
  )
  // On a resume or restore the chain keeps `command` fixed (PLUGIN_HOOK_SPECS frozen).
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
