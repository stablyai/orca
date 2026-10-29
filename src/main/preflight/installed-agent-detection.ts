// orca skills loads detection outside Electron; exclude integration-client dependencies.
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds,
  type TuiAgentDetectionCommand
} from '../../shared/tui-agent-detection-commands'
import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { detectAgentCommandsOnHost } from './agent-command-detection'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import type { TuiAgent } from '../../shared/tui-agent'

export type InstalledAgentDetectionOptions = {
  /** Agents disabled in Settings → Agents. Background callers skip probing them entirely. */
  disabledTuiAgents?: readonly TuiAgent[]
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

export async function detectInstalledAgents(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<string[]> {
  const runtime = getPreflightWslTarget(context) ? 'wsl' : process.platform
  const commands = activeDetectionCommands(options)
  const probeCommands = getTuiAgentDetectionProbeCommands(commands, runtime)
  return resolveDetectedTuiAgentIds(
    commands,
    await detectAgentCommandsOnHost(probeCommands, { context }),
    runtime
  )
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context, options)
}
