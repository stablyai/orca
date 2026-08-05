import { resolveCliCommands } from '../codex-cli/command'
import {
  detectedAgentInventorySchema,
  emptyDetectedAgentInventory,
  legacyDetectedAgentInventory
} from '../../shared/detected-agent-inventory'
import { hydrateShellPathForAgentDetection } from './agent-detection-shell-path'
import { detectCommandsInInstallDirs } from './local-agent-install-dir-detection'
import {
  execCommandInWsl,
  execLocalPreflightCommand,
  isCommandOnPath,
  shellQuote
} from './preflight-command-exec'
import type { PreflightRuntimeContext } from './preflight-runtime-target'
import { getPreflightWslTarget } from './preflight-runtime-target'
import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import { getActiveMultiplexer } from './ssh'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgents,
  type DetectedTuiAgentsResult
} from './tui-agent-detection-commands'

export async function detectInstalledAgents(context?: PreflightRuntimeContext): Promise<string[]> {
  return (await detectInstalledAgentCommands(context)).agents
}

export async function detectInstalledAgentCommands(
  context?: PreflightRuntimeContext
): Promise<DetectedTuiAgentsResult> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    const foundCommands = await detectWslCommandsOnPath(
      wslTarget,
      getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, 'wsl')
    )
    await removeFailedCapabilityProbes(foundCommands, wslTarget)
    return resolveDetectedTuiAgents(KNOWN_TUI_AGENT_DETECTION_COMMANDS, foundCommands, 'wsl')
  }

  const probeCommands = getTuiAgentDetectionProbeCommands(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    process.platform
  )
  const pathChecks = await Promise.all(
    probeCommands.map(async (cmd) => ({
      cmd,
      installedOnPath: await isCommandOnPath(cmd)
    }))
  )
  const missedCommands = pathChecks.filter((check) => !check.installedOnPath).map(({ cmd }) => cmd)
  const installDirCommands = detectCommandsInInstallDirs(missedCommands)
  const foundCommands = new Set(
    pathChecks
      .filter(({ cmd, installedOnPath }) => installedOnPath || installDirCommands.has(cmd))
      .map(({ cmd }) => cmd)
  )
  await removeFailedCapabilityProbes(foundCommands)
  return resolveDetectedTuiAgents(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    foundCommands,
    process.platform
  )
}

async function removeFailedCapabilityProbes(
  foundCommands: Set<string>,
  wslTarget?: ReturnType<typeof getPreflightWslTarget>
): Promise<void> {
  const commands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter(
    (command) => command.capabilityProbe && foundCommands.has(command.cmd)
  )
  let resolvedLocalCommands = new Map<string, string>()
  if (!wslTarget) {
    try {
      resolvedLocalCommands = resolveCliCommands(commands.map((command) => command.cmd))
    } catch {
      // PATH resolution below remains the bounded fallback.
    }
  }
  await Promise.all(
    commands.map(async (command) => {
      try {
        if (wslTarget) {
          const invocation = [command.cmd, ...(command.capabilityProbe?.args ?? [])]
            .map(shellQuote)
            .join(' ')
          await execCommandInWsl(wslTarget, invocation)
        } else {
          await execLocalPreflightCommand(resolvedLocalCommands.get(command.cmd) ?? command.cmd, [
            ...(command.capabilityProbe?.args ?? [])
          ])
        }
      } catch {
        foundCommands.delete(command.cmd)
      }
    })
  )
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context)
}

export async function detectInstalledAgentCommandsWithShellPathHydration(
  context?: PreflightRuntimeContext
): Promise<DetectedTuiAgentsResult> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgentCommands(context)
}

export const detectInstalledAgentInventoryWithShellPathHydration =
  detectInstalledAgentCommandsWithShellPathHydration

export async function detectRemoteAgentCommands(args: {
  connectionId: string
}): Promise<DetectedTuiAgentsResult> {
  const mux = getActiveMultiplexer(args.connectionId)
  if (!mux || mux.isDisposed()) {
    return emptyDetectedAgentInventory()
  }
  try {
    return detectedAgentInventorySchema.parse(
      await mux.request('preflight.detectAgentInventory', {
        version: 1,
        commands: KNOWN_TUI_AGENT_DETECTION_COMMANDS
      })
    )
  } catch {
    try {
      return legacyDetectedAgentInventory(
        (await detectRemoteAgents(args)) as DetectedTuiAgentsResult['agents']
      )
    } catch {
      return emptyDetectedAgentInventory()
    }
  }
}

export async function detectRemoteAgents(args: { connectionId: string }): Promise<string[]> {
  const mux = getActiveMultiplexer(args.connectionId)
  if (!mux || mux.isDisposed()) {
    return []
  }
  const result = (await mux.request('preflight.detectAgents', {
    commands: KNOWN_TUI_AGENT_DETECTION_COMMANDS
  })) as { agents: string[] }
  return [...new Set(result.agents)]
}

export const detectRemoteAgentInventory = detectRemoteAgentCommands
