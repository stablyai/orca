import { basename } from 'node:path'
import { replaceLaunchPrograms } from '../../shared/agent-launch/startup/managed-agent-launch-program'
import { getFirstCommandToken } from '../../shared/shell/command-resolution/command-token-scanner'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import {
  getTuiAgentLaunchCommand,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/agent-launch/catalog/tui-agent-config'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { readHostManagedAgentCommands } from '../runtime/rpc/methods/host-management/managed-copy-detection'
import {
  installedManagedAgentFolder,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli
} from './managed-agent-cli-registry'

type SpawnHost = {
  shell: AgentStartupShell
  /** A WSL terminal, which can't run this host's copies. */
  wsl: boolean
  /** Settings for the launch lookup; without them a plain name is left alone. */
  settings: Parameters<typeof readHostManagedAgentCommands>[0] | undefined
}

/** Orca's copies move with each update and can be removed, and a launch can start before the
 *  host's list loads, so a terminal Orca starts is aligned with what this host can run now. */
export async function alignManagedAgentLaunchAtSpawn(
  spawn: {
    launchCommand: string | undefined
    codexRuntime?: 'host' | 'wsl'
    getSettings?: () => SpawnHost['settings']
  },
  shell: AgentStartupShell
): Promise<string | undefined> {
  const command = spawn.launchCommand
  if (!command) {
    return command
  }
  const host = { shell, wsl: spawn.codexRuntime === 'wsl', settings: spawn.getSettings?.() }
  const aligned = withInstalledManagedReleases(command, host)
  return host.wsl || !host.settings ? aligned : withHostProgramForStockName(aligned, host)
}

function withInstalledManagedReleases(command: string, host: SpawnHost): string {
  const dataDirectory = getProfileUserDataPath()
  const copies = MANAGED_AGENT_CLI_IDS.map((agent) => ({
    agent,
    root: managedAgentCli(agent).runtime.root(dataDirectory)
  })).filter(
    // Most launches name no copy; only those pay for more than this check. A Command setting
    // naming a path is run as written.
    ({ agent, root }) => command.includes(root) && !settingNamesOwnProgram(agent, host.settings)
  )
  if (copies.length === 0) {
    return command
  }
  return replaceLaunchPrograms(command, host.shell, (program) => {
    const copy = copies.find(
      ({ root }) =>
        program.startsWith(root) && /^[\\/][^\\/]+[\\/]/.test(program.slice(root.length))
    )
    if (!copy) {
      return null
    }
    const folder = host.wsl ? null : installedManagedAgentFolder(copy.agent)
    if (!folder) {
      return basename(program).replace(/\.(exe|cmd|bat|ps1)$/i, '')
    }
    // Releases sit directly under the root; an earlier one moves to the installed one.
    const inRelease = program.slice(copy.root.length + 1).replace(/^[^\\/]+/, '')
    return folder + inRelease
  })
}

/** A Command setting whose program isn't the agent's stock name, which Orca never rewrites. */
function settingNamesOwnProgram(agent: TuiAgent, settings: SpawnHost['settings']): boolean {
  const setting = settings?.agentCmdOverrides?.[agent]?.trim()
  return !!setting && getFirstCommandToken(setting) !== stockProgram(agent)
}

function stockProgram(agent: TuiAgent): string {
  return getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], process.platform).split(' ')[0]
}

let agentsByStockProgram: Map<string, TuiAgent> | null = null

function stockProgramAgent(program: string): TuiAgent | undefined {
  return stockPrograms().get(program)
}

function stockPrograms(): Map<string, TuiAgent> {
  if (!agentsByStockProgram) {
    agentsByStockProgram = new Map()
    for (const agent of Object.keys(TUI_AGENT_CONFIG)) {
      if (isTuiAgent(agent) && !agentsByStockProgram.has(stockProgram(agent))) {
        agentsByStockProgram.set(stockProgram(agent), agent)
      }
    }
  }
  return agentsByStockProgram
}

/** A launch naming an agent's stock program runs the program this host launches for it by full
 *  path, where there is one: Orca's copy without a user CLI, or a user CLI found only outside PATH. */
async function withHostProgramForStockName(command: string, host: SpawnHost): Promise<string> {
  const settings = host.settings
  // Most terminals name no agent; only those pay for reading the line.
  if (!settings || ![...stockPrograms().keys()].some((program) => command.includes(program))) {
    return command
  }
  const agents = new Set<TuiAgent>()
  replaceLaunchPrograms(command, host.shell, (program) => {
    const agent = stockProgramAgent(program)
    if (agent) {
      agents.add(agent)
    }
    return null
  })
  if (agents.size === 0) {
    return command
  }
  const paths = await readHostManagedAgentCommands(settings, [...agents])
  return replaceLaunchPrograms(command, host.shell, (program) => {
    const agent = stockProgramAgent(program)
    return (agent && paths[agent]) || null
  })
}
