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
} from '../ipc/preflight-runtime-target'
import { detectAgentCommandsOnHost } from './agent-command-detection'
import { normalizeDisabledTuiAgents } from '../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { TuiAgentDetectionRuntime } from '../../shared/agent-launch/catalog/tui-agent-config-types'
import { extractExecutableToken } from '../../shared/managed-agent-command-token'

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

export async function detectInstalledAgents(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<string[]> {
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
  const found = await detectAgentCommandsOnHost(probeCommands, { context })
  const detected = resolveDetectedTuiAgentIds(commands, found, runtime)
  for (const [id, probe] of overrides) {
    if (
      !detected.includes(id) &&
      found.has(probe.command) &&
      probe.requiredCommands.every((required) => found.has(required))
    ) {
      detected.push(id)
    }
  }
  return detected
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context, options)
}
