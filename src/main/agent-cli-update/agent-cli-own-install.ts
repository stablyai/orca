// The user's own agent CLI on this host, as a new chat finds it; never Orca's copy.

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
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
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { homebrewInstallTap } from './homebrew-install-tap'

export type AgentCliUpdateSettings = LaunchEnvironmentSettings &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>>

export type OwnAgentCli = {
  program: string
  /** The installed file behind any PATH link, which says how it was installed. */
  realPath: string
  /** The Homebrew tap that installed it, when it is a Homebrew formula. */
  homebrewTap: string | null
  env: Record<string, string>
  /** The command name the user types. */
  command: string
  /** Read as a chat's version check reads it. */
  version: { prefixArgs: readonly string[]; env: Record<string, string> }
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
  // ACP chats also search their installers' folders after PATH.
  const spec = acpLaunchSpecFor(agent)
  const command = spec?.command ?? agent
  const pathEnv = [
    env.PATH ?? env.Path,
    ...(spec?.installDirectories({ env, homePath: homePath ?? homedir() }) ?? [])
  ]
    .filter(Boolean)
    .join(delimiter)
  const program = await resolveCliCommandAsync(command, {
    pathEnv: pathEnv || null,
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
  return {
    program,
    realPath,
    homebrewTap: await homebrewInstallTap(realPath),
    env,
    command,
    version: { prefixArgs: spec?.versionArgs ?? [], env: { ...env, ...spec?.env } }
  }
}
