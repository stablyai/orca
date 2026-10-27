import type { IPty } from 'node-pty'
import {
  isPtyJobOwnershipAvailable,
  listPtyJobProcessIds,
  ptyShellProcessId
} from '../windows/windows-pty-job'

/** Read job membership without console-helper forks (#10857); null is unverifiable, never exit proof.
 * Complete membership proves known-anchor liveness/exit and shell-alone state. Unanchored extra members
 * may be detached leftovers, so callers must age-bound that evidence rather than claim agent liveness. */
export function readWindowsPtyJobProcessIds(
  proc: IPty,
  listJobProcessIds: (proc: IPty) => readonly number[] | null = listPtyJobProcessIds
): ReadonlySet<number> | null {
  const pids = listJobProcessIds(proc)
  if (!pids) {
    return null
  }
  const membership = new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))
  // A size-one set lacking the shell proves a surviving child, never shell-alone state.
  const shellPid = ptyShellProcessId(proc)
  if (shellPid === undefined || !membership.has(proc.pid) || !membership.has(shellPid)) {
    return null
  }
  if (shellPid !== proc.pid) {
    membership.delete(proc.pid)
  }
  return membership
}

/** Missing native exports are unsupported, distinct from an attempted but unavailable read. */
export function isWindowsPtyJobReadable(): boolean {
  return isPtyJobOwnershipAvailable()
}
