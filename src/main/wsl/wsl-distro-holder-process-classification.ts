import type { WindowsProcessEvidence } from '../daemon/daemon-incarnation-evidence-types'
import { isWslDistroHolderCommandLine } from './wsl-distro-holder-command'
import type { WslDistroHolderRecord } from './wsl-distro-holder-record'
import type { WslDistroHolderState } from './wsl-distro-holder-types'

/**
 * Pid + creation time + command line must all agree; any one contradicting means pid reuse.
 * `commandLineSuffices` (uninstall only): a matching command line is enough when a time is missing.
 */
export function classifyWslDistroHolderProcess(
  record: WslDistroHolderRecord,
  evidence: WindowsProcessEvidence,
  { commandLineSuffices = false } = {}
): WslDistroHolderState {
  if (evidence.status === 'unavailable') {
    return 'unverifiable'
  }
  if (evidence.status === 'missing') {
    return 'exited'
  }
  const timeKnown = record.creationTimeMs !== null && evidence.startedAtMs !== null
  if (timeKnown && record.creationTimeMs !== evidence.startedAtMs) {
    return 'exited'
  }
  if (!evidence.commandLine) {
    return 'unverifiable'
  }
  if (!isWslDistroHolderCommandLine(evidence.commandLine, record.distro)) {
    return 'exited'
  }
  // A record written without a creation time never had one to compare; the command line decides.
  return timeKnown || record.creationTimeMs === null || commandLineSuffices
    ? 'live'
    : 'unverifiable'
}
