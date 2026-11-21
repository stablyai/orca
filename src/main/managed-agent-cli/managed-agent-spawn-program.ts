import { basename, isAbsolute } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import { replaceLaunchProgram } from '../../shared/agent-launch/startup/managed-agent-launch-program'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import {
  installedManagedAgentLauncher,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli
} from './managed-agent-cli-registry'

/** What a terminal starting `program` runs when it names one of Orca's copies: the release
 *  installed now (a list read before an update names an earlier one), or the stock name where no
 *  copy can run (removed, or inside WSL, which can't run this host's copies). Null otherwise. */
export function managedAgentProgramAtSpawn(
  program: string,
  { wsl }: { wsl: boolean }
): string | null {
  if (!isAbsolute(program)) {
    return null
  }
  const dataDirectory = getProfileUserDataPath()
  const agent = MANAGED_AGENT_CLI_IDS.find((id) =>
    isPathInsideOrEqual(managedAgentCli(id).runtime.root(dataDirectory), program)
  )
  if (!agent) {
    return null
  }
  return (
    (wsl ? null : installedManagedAgentLauncher(agent)) ??
    basename(program).replace(/\.(exe|cmd|bat|ps1)$/i, '')
  )
}

/** Orca's copies move with each update, so a launch built from an older list runs the current one. */
export function withManagedAgentProgramAtSpawn(
  command: string | undefined,
  shell: AgentStartupShell,
  host: { wsl: boolean }
): string | undefined {
  return command === undefined
    ? command
    : replaceLaunchProgram(command, shell, (program) => managedAgentProgramAtSpawn(program, host))
}
