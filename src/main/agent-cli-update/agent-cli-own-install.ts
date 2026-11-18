// The user's own Claude Code or Codex CLI on this host, as a new chat finds it; never Orca's copy.

import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { AgentCliUpdateAgent } from '../../shared/agent-launch/installation/agent-cli-update'
import { hasExplicitTuiLaunchCommand } from '../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { resolveCliCommandAsync } from '../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import {
  resolveHostStructuredAgentLaunchEnvironment,
  type LaunchEnvironmentSettings
} from '../runtime/agent-session/launch/structured-agent-launch-support'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export type AgentCliUpdateSettings = LaunchEnvironmentSettings &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>>

export type OwnAgentCli = {
  program: string
  /** The installed file behind any PATH link, which says how it was installed. */
  realPath: string
  env: Record<string, string>
}

// A WSL host can't run a Windows-drive copy, so it isn't the user's own install there.
const WINDOWS_DRIVE_MOUNT = /^\/mnt\/[a-z]\//i

export async function findOwnAgentCli(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<OwnAgentCli | null> {
  // A Command setting may name a wrapper, which has no update of its own.
  if (hasExplicitTuiLaunchCommand(settings, agent)) {
    return null
  }
  const env = await resolveHostStructuredAgentLaunchEnvironment(agent, settings)
  const homePath = env.HOME ?? env.USERPROFILE
  const program = await resolveCliCommandAsync(agent, {
    pathEnv: env.PATH ?? env.Path ?? null,
    ...(homePath ? { homePath } : {})
  })
  if (!isAbsolute(program) || WINDOWS_DRIVE_MOUNT.test(program)) {
    return null
  }
  const realPath = await realpath(program).catch(() => null)
  // Orca's own copies live in its data folder and update without asking.
  if (
    !realPath ||
    isPathInsideOrEqual(join(getProfileUserDataPath(), 'agent-runtimes'), realPath)
  ) {
    return null
  }
  return { program, realPath, env }
}
