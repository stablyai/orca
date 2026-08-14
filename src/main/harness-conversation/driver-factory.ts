import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { resolveTuiAgentPermissionMode } from '../../shared/tui-agent-permissions'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import type { HarnessConversationDriverFactory } from './driver'
import { AcpConversationDriver } from './acp-driver'
import { ClaudeConversationDriver } from './claude-driver'

type DriverSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>
>

export function createHarnessConversationDriverFactory(
  getSettings: (input: { conversationId: string }) => DriverSettings
): HarnessConversationDriverFactory {
  return async ({
    conversationId,
    agent,
    cwd,
    providerSessionId,
    newProviderSessionId,
    forkFromProviderSessionId,
    spawnToken,
    providerEnvironment,
    sink
  }) => {
    const settings = getSettings({ conversationId })
    const invocation = resolveInvocation(
      settings.agentCmdOverrides?.[agent] ?? TUI_AGENT_CONFIG[agent].launchCmd
    )
    const agentArgs = resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs)
    const agentEnv = resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv)
    const permissionMode = resolveTuiAgentPermissionMode({ agent, agentArgs, agentEnv })
    const env = {
      ...process.env,
      ...agentEnv,
      ...providerEnvironment,
      ORCA_AGENT_SESSION_SPAWN_TOKEN: spawnToken,
      ORCA_MACHINE_SESSION: '1'
    }
    const base = {
      cwd,
      providerSessionId,
      newProviderSessionId,
      forkFromProviderSessionId,
      command: invocation.command,
      permissionMode,
      env,
      sink
    }
    if (agent === 'claude') {
      return new ClaudeConversationDriver({ ...base, commandArgs: invocation.args })
    }
    if (agent === 'codex') throw new Error('codex uses the app-server structured adapter')
    const subcommand = agent === 'grok' ? ['agent', 'stdio'] : ['acp']
    return new AcpConversationDriver({
      ...base,
      args: endsWith(invocation.args, subcommand)
        ? invocation.args
        : [...invocation.args, ...resolveArgs(agentArgs), ...subcommand]
    })
  }
}

function resolveArgs(args: string): string[] {
  if (!args.trim()) {
    return []
  }
  const parsed = tokenizeStartupCommand(
    `orca-agent ${args}`,
    process.platform === 'win32' ? 'powershell' : 'posix'
  )
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.tokens.slice(1)
}

function resolveInvocation(command: string): { command: string; args: string[] } {
  const parsed = tokenizeStartupCommand(
    command,
    process.platform === 'win32' ? 'powershell' : 'posix'
  )
  if (!parsed.ok || !parsed.tokens[0]) {
    throw new Error(parsed.ok ? 'agent_command_empty' : parsed.error)
  }
  return { command: parsed.tokens[0], args: parsed.tokens.slice(1) }
}

function endsWith(values: readonly string[], suffix: readonly string[]): boolean {
  return suffix.every((value, index) => values[values.length - suffix.length + index] === value)
}
