import { basename, isAbsolute } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import {
  launchProgramHead,
  replaceLaunchProgram
} from '../../shared/agent-launch/startup/managed-agent-launch-program'
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

function withInstalledManagedReleases(command: string, { shell, wsl }: SpawnHost): string {
  const dataDirectory = getProfileUserDataPath()
  let aligned = command
  for (const agent of MANAGED_AGENT_CLI_IDS) {
    const root = managedAgentCli(agent).runtime.root(dataDirectory)
    // Most launches name no copy; only those pay for more than this check.
    if (!aligned.includes(root)) {
      continue
    }
    const folder = wsl ? null : installedManagedAgentFolder(agent)
    aligned = folder
      ? // Releases sit directly under the root; an earlier one anywhere in the line (inside a
        // `cd … &&` or `sh -c` wrapper too) moves to the installed one.
        aligned.replace(new RegExp(`${escapeRegExp(root)}[\\\\/][^\\\\/'"\\s]+`, 'g'), (release) =>
          release === folder ? release : folder
        )
      : replaceLaunchProgram(aligned, shell, (program) =>
          isAbsolute(program) && isPathInsideOrEqual(root, program)
            ? basename(program).replace(/\.(exe|cmd|bat|ps1)$/i, '')
            : null
        )
  }
  return aligned
}

const STOCK_HEAD = /^(\s*)([A-Za-z0-9][\w.-]*)(?=\s|$)/
let agentsByStockProgram: Map<string, TuiAgent> | null = null

function stockProgramAgent(program: string): TuiAgent | undefined {
  if (!agentsByStockProgram) {
    agentsByStockProgram = new Map()
    for (const [agent, config] of Object.entries(TUI_AGENT_CONFIG)) {
      const [stock] = getTuiAgentLaunchCommand(config, process.platform).split(' ')
      if (isTuiAgent(agent) && !agentsByStockProgram.has(stock)) {
        agentsByStockProgram.set(stock, agent)
      }
    }
  }
  return agentsByStockProgram.get(program)
}

/** A launch naming an agent's stock program runs the program this host launches for it by full
 *  path, where there is one: Orca's copy without a user CLI, or a user CLI found only outside PATH. */
async function withHostProgramForStockName(command: string, host: SpawnHost): Promise<string> {
  const match = STOCK_HEAD.exec(command)
  const agent = match ? stockProgramAgent(match[2]) : undefined
  if (!match || !agent || !host.settings) {
    return command
  }
  const path = (await readHostManagedAgentCommands(host.settings, [agent]))[agent]
  return path
    ? match[1] + launchProgramHead(path, host.shell) + command.slice(match[0].length)
    : command
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
