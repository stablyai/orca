import type { IPty } from 'node-pty'
import { isPtyJobOwnershipAvailable, listPtyJobProcessIds } from '../windows/windows-pty-job'

/**
 * Processes still running under a pane, or null when there is no answer.
 *
 * Read from the pane's Win32 job object. `GetConsoleProcessList` would need
 * console attachment, which is why node-pty answers it by forking a helper, and
 * why asking on a foreground poll exhausted memory (#10857).
 * `QueryInformationJobObject` has no such constraint: one syscall, no children.
 *
 * The job is a SUPERSET of the console -- it keeps console-detached descendants
 * -- so `size > 1` is not proof of life, only absence of proof of absence.
 * `size === 1` (the shell alone) is decisive, and so is membership of a KNOWN
 * pid: the list is complete when non-null and a job is inescapable once joined,
 * so an anchored identity can be confirmed or retired exactly
 * (judgeCachedAgentJobEvidence). Callers must bound only the unanchored rest.
 *
 * Null means unverifiable per docs/reference/ssh-execution-boundary.md, never
 * that processes died.
 */
export function readWindowsPtyJobProcessIds(
  proc: IPty,
  listJobProcessIds: (proc: IPty) => readonly number[] | null = listPtyJobProcessIds
): ReadonlySet<number> | null {
  const pids = listJobProcessIds(proc)
  if (!pids) {
    return null
  }
  const membership = new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))
  // Without the shell, a size-1 set would read as "shell alone, retire" when it
  // means the opposite. The forked probe this replaced refused the same way.
  return membership.has(proc.pid) ? membership : null
}

/**
 * Whether this build's node-pty exports the job reads at all.
 *
 * Lives beside the read because callers must not confuse "asked and got no
 * answer" with "there was nothing to ask" -- only the former is unverifiable.
 */
export function isWindowsPtyJobReadable(): boolean {
  return isPtyJobOwnershipAvailable()
}
