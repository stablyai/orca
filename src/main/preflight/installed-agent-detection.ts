// orca skills loads detection outside Electron; exclude integration-client dependencies.
import { homedir } from 'node:os'
import path from 'node:path'
import {
  getTuiAgentDetectionProbeCommands,
  isDetectionUnsupportedInRuntime,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds,
  type TuiAgentDetectionCommand
} from '../../shared/agent-launch/catalog/tui-agent-detection-commands'
import { hydrateShellPathForAgentDetection } from '../ipc/command-path/agent-detection-shell-path'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import { detectAgentCommandLocationsOnHost } from './agent-command-detection'
import { normalizeDisabledTuiAgents } from '../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { TuiAgentDetectionRuntime } from '../../shared/agent-launch/catalog/tui-agent-config-types'
import { extractExecutableToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import {
  getTuiAgentLaunchCommand,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/agent-launch/catalog/tui-agent-config'
import { readInstalledManagedAgents, readManagedAgentCommand } from './managed-agent-detection'

export type InstalledAgentDetectionOptions = {
  /** Agents disabled in Settings → Agents. Background callers skip probing them entirely. */
  disabledTuiAgents?: readonly TuiAgent[]
  /** Settings → Agents command overrides on this host; a resolvable override counts as installed. */
  agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
}

function activeDetectionCommands(
  options?: InstalledAgentDetectionOptions
): TuiAgentDetectionCommand[] {
  const disabled = new Set(normalizeDisabledTuiAgents(options?.disabledTuiAgents))
  if (disabled.size === 0) {
    return KNOWN_TUI_AGENT_DETECTION_COMMANDS
  }
  // A disabled agent is not a detection result even when another agent probes the same command.
  return KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter((command) => !disabled.has(command.id))
}

/** Options carrying only configured overrides, so hosts without any keep the plain PATH probe. */
export function agentCommandOverrideDetectionOptions(
  overrides: InstalledAgentDetectionOptions['agentCmdOverrides']
): InstalledAgentDetectionOptions | undefined {
  return overrides && Object.values(overrides).some((command) => command?.trim())
    ? { agentCmdOverrides: overrides }
    : undefined
}

type OverrideProbe = { command: string; requiredCommands: string[] }

function overrideExecutableToken(
  override: string | undefined,
  platform: NodeJS.Platform
): string | null {
  // PowerShell needs `& "C:\path with spaces\agy.exe"` to run a quoted path; the call operator is not the executable.
  const input = platform === 'win32' ? override?.trim().replace(/^&\s+/, '') : override
  const token = extractExecutableToken(input, { platform })
  // Probing only stats the path (WSL quotes it), so reject just what cannot name a file.
  return token && !/[\0\r\n]/.test(token) ? token : null
}

/** Each enabled agent's override executable, probed on the same host as the default commands. */
function overrideProbeCommands(
  commands: readonly TuiAgentDetectionCommand[],
  overrides: InstalledAgentDetectionOptions['agentCmdOverrides'],
  runtime: TuiAgentDetectionRuntime
): Map<TuiAgent, OverrideProbe> {
  const probes = new Map<TuiAgent, OverrideProbe>()
  if (!overrides) {
    return probes
  }
  const platform = runtime === 'wsl' ? 'linux' : process.platform
  const supported = commands.filter((command) => !isDetectionUnsupportedInRuntime(command, runtime))
  for (const id of new Set(supported.map((command) => command.id))) {
    const token = overrideExecutableToken(overrides[id], platform)
    if (!token) {
      continue
    }
    // The terminal shell expands `~`; the WSL probe runs unexpanded, so only expand on this machine.
    const command =
      runtime !== 'wsl' &&
      (token.startsWith('~/') || (platform === 'win32' && token.startsWith('~\\')))
        ? path.join(homedir(), token.slice(2))
        : token
    const own = supported.filter((entry) => entry.id === id)
    const ownCommands = new Set(own.map((entry) => entry.cmd))
    // The override replaces the agent's own binary, not a separate CLI it depends on.
    const requiredCommands = own
      .flatMap((entry) => entry.requiredCommands ?? [])
      .filter((required) => !ownCommands.has(required))
    probes.set(id, { command, requiredCommands })
  }
  return probes
}

/** Full paths to Orca's copies, for agents whose own CLI the host doesn't have. */
export type ManagedAgentCommands = Partial<Record<TuiAgent, string>>

export type InstalledAgentInventory = {
  agents: string[]
  /** Absent for a WSL guest: Orca's copies live on the host, so it reports none. */
  managedAgentCommands?: ManagedAgentCommands
}

async function detectAgentsWithManagedCopies(
  context: PreflightRuntimeContext | undefined,
  options: InstalledAgentDetectionOptions | undefined
): Promise<{
  detected: string[]
  managedOnly: TuiAgent[] | null
  outsidePath: ManagedAgentCommands
}> {
  const runtime = getPreflightWslTarget(context) ? 'wsl' : process.platform
  const commands = activeDetectionCommands(options)
  // Why: a CLI outside PATH (e.g. agy in a custom install dir) is reachable only through its override.
  const overrides = overrideProbeCommands(commands, options?.agentCmdOverrides, runtime)
  const probeCommands = [
    ...new Set([
      ...getTuiAgentDetectionProbeCommands(commands, runtime),
      ...[...overrides.values()].map((probe) => probe.command)
    ])
  ]
  const { found, outsidePath: foundOutsidePath } = await detectAgentCommandLocationsOnHost(
    probeCommands,
    { context }
  )
  const detected = resolveDetectedTuiAgentIds(commands, found, runtime)
  // A terminal can't run by name a CLI found only in its installer's folder, so launches name its path.
  const outsidePath: ManagedAgentCommands = {}
  for (const id of runtime === 'wsl' ? [] : detected.filter(isTuiAgent)) {
    const [program] = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[id], runtime).split(' ')
    const path = foundOutsidePath.get(program)
    if (path && !options?.agentCmdOverrides?.[id]?.trim()) {
      outsidePath[id] = path
    }
  }
  // Orca's own copies live on this host, not in a WSL guest. Launches run them by full path.
  const managedOnly: TuiAgent[] | null = runtime === 'wsl' ? null : []
  if (managedOnly) {
    const enabled = new Set(commands.map((command) => command.id))
    for (const id of await readInstalledManagedAgents()) {
      if (isTuiAgent(id) && enabled.has(id) && !detected.includes(id)) {
        detected.push(id)
        managedOnly.push(id)
      }
    }
  }
  for (const [id, probe] of overrides) {
    if (
      !detected.includes(id) &&
      found.has(probe.command) &&
      probe.requiredCommands.every((required) => found.has(required))
    ) {
      detected.push(id)
    }
  }
  return { detected, managedOnly, outsidePath }
}

export async function detectInstalledAgentInventory(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<InstalledAgentInventory> {
  const { detected, managedOnly, outsidePath } = await detectAgentsWithManagedCopies(
    context,
    options
  )
  if (!managedOnly) {
    return { agents: detected }
  }
  const paths = await Promise.all(managedOnly.map(readManagedAgentCommand))
  const managedAgentCommands: ManagedAgentCommands = { ...outsidePath }
  managedOnly.forEach((id, index) => {
    const path = paths[index]
    if (path) {
      managedAgentCommands[id] = path
    }
  })
  return { agents: detected, managedAgentCommands }
}

export async function detectInstalledAgents(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<string[]> {
  return (await detectAgentsWithManagedCopies(context, options)).detected
}

export async function detectInstalledAgentInventoryWithShellPathHydration(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<InstalledAgentInventory> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgentInventory(context, options)
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context, options)
}
