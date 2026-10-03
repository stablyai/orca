import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { join } from 'node:path'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { getSelectedGrokAccountHome } from './paths'
import { grokHookService } from '../grok/hook-service'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { shouldSkipCodexHomeEnvForWindowsShell } from '../ipc/pty/host-env/codex-home'
import type { BuildPtyHostEnvOptions } from '../ipc/pty/host-env/types'

export function applyGrokAccountToPtyEnv(
  baseEnv: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): void {
  if (opts.isWsl) {
    return
  }
  const home = baseEnv.GROK_HOME || getSelectedGrokAccountHome()
  if (!home) {
    return
  }
  baseEnv.GROK_HOME = home
  baseEnv.GROK_LEADER_SOCKET ??= join(home, 'leader.sock')
  if (opts.agentStatusHooksEnabled && isTuiAgentEnabled('grok', opts.disabledTuiAgents)) {
    grokHookService.install({ home })
  }
}

type GrokTerminalOptions = {
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: string
  shellOverride?: string
  cwd?: string
}

export function pinGrokTerminalCreateOptions<T extends GrokTerminalOptions>(
  options: T,
  workspace: { connectionId?: string | null; path: string },
  defaultShell?: string
): T {
  return {
    ...options,
    ...pinGrokLaunchAccount(
      options.env,
      options.launchConfig,
      options.launchAgent,
      !workspace.connectionId &&
        !shouldSkipCodexHomeEnvForWindowsShell(
          options.shellOverride ?? defaultShell,
          options.cwd ?? workspace.path
        )
    )
  }
}

export function pinGrokLaunchAccount(
  env: Record<string, string> | undefined,
  launchConfig: SleepingAgentLaunchConfig | undefined,
  launchAgent: string | undefined,
  nativeLocal: boolean
): {
  env: Record<string, string> | undefined
  launchConfig: SleepingAgentLaunchConfig | undefined
} {
  if (!nativeLocal || (launchAgent !== 'grok' && launchConfig?.agentCommand !== 'grok')) {
    return { env, launchConfig }
  }
  const home =
    launchConfig?.agentEnv.GROK_HOME ??
    env?.GROK_HOME ??
    getSelectedGrokAccountHome() ??
    resolveGrokHomeDir()
  const socket =
    launchConfig?.agentEnv.GROK_LEADER_SOCKET ??
    env?.GROK_LEADER_SOCKET ??
    join(home, 'leader.sock')
  return {
    env: { ...env, GROK_HOME: home, GROK_LEADER_SOCKET: socket },
    launchConfig: launchConfig
      ? {
          ...launchConfig,
          agentEnv: { ...launchConfig.agentEnv, GROK_HOME: home, GROK_LEADER_SOCKET: socket }
        }
      : undefined
  }
}
