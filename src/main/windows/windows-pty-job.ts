import type { TerminalProcess } from '../../shared/terminal-process'
import { canUseBunPty } from '../daemon/pty-subprocess/bun-pty-process-capabilities'
import { loadWindowsBunPtyJobNative } from '../daemon/pty-subprocess/windows-bun-pty-native'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

export type JobTerminationOutcome = 'terminated' | 'unavailable'

type SelfOwnedPty = Pick<TerminalProcess, 'pid'> & {
  jobRootProcessIsWrapper?: true
  shellProcessId?: number
  terminateOwnedTree?: () => JobTerminationOutcome
  listOwnedProcessIds?: () => readonly number[] | null
}

/** The gate's pid never proves that its user shell remains alive. */
export function ptyShellProcessId(proc: SelfOwnedPty): number | undefined {
  const owned: SelfOwnedPty = proc
  return owned.jobRootProcessIsWrapper ? owned.shellProcessId : proc.pid
}

/** Only the terminal's retained job handle can authorize whole-tree termination. */
export function terminatePtyJob(proc: SelfOwnedPty): JobTerminationOutcome {
  const owned: SelfOwnedPty = proc
  if (!owned.terminateOwnedTree) {
    return 'unavailable'
  }
  let outcome: JobTerminationOutcome
  try {
    outcome = owned.terminateOwnedTree()
  } catch {
    return 'unavailable'
  }
  if (outcome === 'terminated') {
    recordSelfInitiatedTreeKill({
      pid: proc.pid,
      site: 'windows-pty-job-teardown',
      scope: 'win-pty-job'
    })
  }
  return outcome
}

/** A missing or unreadable job is unverifiable, never evidence that its processes exited. */
export function listPtyJobProcessIds(proc: SelfOwnedPty): readonly number[] | null {
  const owned: SelfOwnedPty = proc
  try {
    return owned.listOwnedProcessIds?.() ?? null
  } catch {
    return null
  }
}

export function isPtyJobOwnershipAvailable(): boolean {
  return canUseBunPty() && loadWindowsBunPtyJobNative() !== null
}
