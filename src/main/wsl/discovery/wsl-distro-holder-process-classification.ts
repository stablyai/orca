import type { WindowsProcessEvidence } from '../../daemon/endpoint/identity/daemon-incarnation-evidence-types'
import { isWslDistroHolderCommandLine, isWslDistroHolderForUser } from './wsl-distro-holder-command'
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

/** As above, but a live holder running as another account than `user` reads `other-account` (#49180). */
export function classifyWslDistroHolderForAccount(
  record: WslDistroHolderRecord,
  evidence: WindowsProcessEvidence,
  /** null: pins not loaded yet, so no holder is judged another account's. */
  user: string | undefined | null
): WslDistroHolderState | 'other-account' {
  const state = classifyWslDistroHolderProcess(record, evidence)
  const commandLine = evidence.status === 'present' ? evidence.commandLine : null
  return state === 'live' &&
    commandLine &&
    user !== null &&
    !isWslDistroHolderForUser(commandLine, user)
    ? 'other-account'
    : state
}
