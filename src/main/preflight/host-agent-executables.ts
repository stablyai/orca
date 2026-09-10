import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentExecutables
} from '../ipc/tui-agent-detection-commands'
import {
  _resetDetectedTuiAgentExecutables,
  setDetectedTuiAgentExecutables,
  type DetectedAgentExecutables
} from '../../shared/detected-agent-executables'

// Why: null until this host has run detection, so readers know to detect first.
let hostSnapshot: DetectedAgentExecutables | null = null

/**
 * Publishes the executables matched by a host detection pass so launches on this
 * host don't start a missing binary for alias-only installs (Cursor.app's `cursor`
 * without `cursor-agent`). WSL is excluded — its PATH belongs to the distro.
 */
export function publishHostAgentExecutables(
  foundCommands: ReadonlySet<string>,
  runtime: NodeJS.Platform
): void {
  hostSnapshot = resolveDetectedTuiAgentExecutables(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    foundCommands,
    runtime
  )
  setDetectedTuiAgentExecutables(hostSnapshot, runtime)
}

export function getHostAgentExecutableSnapshot(): DetectedAgentExecutables | null {
  return hostSnapshot
}

export function resetHostAgentExecutables(): void {
  hostSnapshot = null
  _resetDetectedTuiAgentExecutables()
}
