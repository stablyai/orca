// orca skills loads detection outside Electron; exclude integration-client dependencies.
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { detectAgentCommandsOnHost } from './agent-command-detection'

export async function detectInstalledAgents(context?: PreflightRuntimeContext): Promise<string[]> {
  const runtime = getPreflightWslTarget(context) ? 'wsl' : process.platform
  const commands = getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
  return resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    await detectAgentCommandsOnHost(commands, { context }),
    runtime
  )
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context)
}
