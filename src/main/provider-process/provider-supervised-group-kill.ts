// The forced step of a POSIX provider close: kill the provider's own process group, then its
// supervisor.
//
// The supervisor starts the provider (the process that writes the conversation) in a process group
// of its own, so a SIGKILL to the supervisor alone leaves the provider running with nobody to stop
// it. Paused, the supervisor cannot reap its child, so the child's row, pid and group id stay
// exactly the provider's until the group kill lands; that is what makes the kill's delivery a fact
// about the provider rather than a guess about a pid.

import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

/**
 * - `killed`: SIGKILL reached the provider's group; nothing in it runs its own code again.
 * - `gone`: the paused supervisor holds no provider, or its group has nothing left to signal.
 * - `unknown`: no exact answer, so nothing was killed and the supervisor runs its own stop.
 */
export type SupervisedProviderKill = 'killed' | 'gone' | 'unknown'

export type SupervisedProviderGroupKillDeps = {
  site: string
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
}

type SupervisorHandle = Pick<ChildProcessHandle, 'kill'>

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  process.kill(-pgid, signal)
}

/** Errors that mean no process in the group can run: ESRCH, an empty group; EPERM, on macOS a
 *  group whose members are all zombies (the provider runs as this user, so a live one is
 *  signalable). */
function groupHasNothingToRun(error: unknown): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node process.kill errors expose an optional errno code; only that field is read.
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ESRCH' || code === 'EPERM'
}

/** The supervisor's own child that leads its own group: the provider. Null when the walk did not
 *  see the supervisor itself, or saw more than one candidate. */
function providerGroupLeader(
  snapshot: DescendantSnapshot,
  supervisorPid: number
): { pid: number } | 'none' | null {
  if (snapshot.rootPgid === null) {
    return null
  }
  const leaders = snapshot.descendants.filter(
    (row) => row.ppid === supervisorPid && row.pgid === row.pid
  )
  if (leaders.length === 0) {
    return 'none'
  }
  return leaders.length === 1 ? leaders[0] : null
}

/**
 * Pauses the supervisor, kills the provider's group, then kills the supervisor. The supervisor is
 * never killed without the group kill: without an exact answer it is resumed so its own stop
 * still reaches the group. Resolves the walk taken while the supervisor was paused, so callers can
 * judge the rest of the tree from the same read.
 */
export async function killSupervisedProviderGroup(
  supervisor: SupervisorHandle,
  supervisorPid: number,
  deps: SupervisedProviderGroupKillDeps
): Promise<{ provider: SupervisedProviderKill; snapshot: DescendantSnapshot | null }> {
  if (!supervisor.kill('SIGSTOP')) {
    // The handle is gone, so the supervisor already exited; its exit is the answer.
    return { provider: 'unknown', snapshot: null }
  }
  const capture = deps.captureDescendants ?? captureDescendantSnapshot
  const snapshot = await capture(supervisorPid).catch(() => null)
  const leader = snapshot ? providerGroupLeader(snapshot, supervisorPid) : null
  if (leader === null) {
    supervisor.kill('SIGCONT')
    return { provider: 'unknown', snapshot }
  }
  if (leader === 'none') {
    // Already reaped by the supervisor, which is mid-way through clearing the rest of its group.
    supervisor.kill('SIGCONT')
    return { provider: 'gone', snapshot }
  }
  const signal = deps.signalProcessGroup ?? signalProcessGroup
  let provider: SupervisedProviderKill
  try {
    signal(leader.pid, 'SIGKILL')
    provider = 'killed'
  } catch (error) {
    if (!groupHasNothingToRun(error)) {
      supervisor.kill('SIGCONT')
      return { provider: 'unknown', snapshot }
    }
    provider = 'gone'
  }
  if (provider === 'killed') {
    recordSelfInitiatedTreeKill({ pid: leader.pid, site: deps.site, scope: 'posix-process-group' })
  }
  supervisor.kill('SIGKILL')
  return { provider, snapshot }
}
