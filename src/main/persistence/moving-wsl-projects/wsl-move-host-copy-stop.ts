/**
 * Before "Use on this computer again" resumes the project's agents here, the host's copies of its
 * terminals must have exited: an agent the move resumed on the host would otherwise keep running
 * beside the local one, two writers on one transcript. Unverifiable is not
 * exited, so a host that does not answer is reported, never assumed stopped.
 */
export type WslMoveHostCopyOutcome = 'stopped' | 'still-running' | 'unreachable'

/** The object form: a running terminal's workspace was put to sleep; opening it resumes them. */
export type WslMoveHostCopyStop =
  | WslMoveHostCopyOutcome
  | { outcome: WslMoveHostCopyOutcome; slept: true }

export function wslMoveHostCopyOutcome(stop: WslMoveHostCopyStop): WslMoveHostCopyOutcome {
  return typeof stop === 'string' ? stop : stop.outcome
}

export function wslMoveHostCopiesSlept(stop: WslMoveHostCopyStop): boolean {
  return typeof stop !== 'string'
}

export type WslMoveHostCopyPort = {
  /**
   * The host workspaces in the move's scope with a terminal there; null when the host does not
   * answer. Asked first and always, so an unanswering host refuses even with nothing else to ask.
   */
  workspacesWithTerminals: () => Promise<readonly string[] | null>
  /** Sleeps the host workspace; false when the host refused, null when it did not answer. */
  sleepWorkspace: (hostWorkspaceId: string) => Promise<boolean | null>
  /** The host workspace's terminals still running; null when the host did not answer. */
  liveTerminals: (hostWorkspaceId: string) => Promise<number | null>
  wait: (ms: number) => Promise<void>
}

// One wall-clock budget for the whole stop, slow answers included, not a count of polls.
const STOP_DEADLINE_MS = 30_000
// What the terminals always get to exit after the last sleep, however long the sleeps took.
const MIN_EXIT_WAIT_MS = 5_000
const EXIT_POLL_MS = 500

export async function stopWslMoveHostCopies(
  sessionWorkspaceIds: readonly string[],
  port: WslMoveHostCopyPort,
  deadlineMs = STOP_DEADLINE_MS,
  now: () => number = Date.now
): Promise<WslMoveHostCopyStop> {
  const deadline = now() + deadlineMs
  // The session here names only workspaces with tabs kept after the move (a moved project keeps
  // just its chats), so the host's own list adds the ones it runs that this computer never saw.
  const listed = await port.workspacesWithTerminals()
  if (listed === null) {
    return 'unreachable'
  }
  const hostWorkspaceIds = [...new Set([...sessionWorkspaceIds, ...listed])]
  // Why first: a host that cannot answer for every workspace must not have any of them stopped.
  const running = new Set<string>()
  for (const id of hostWorkspaceIds) {
    const live = await port.liveTerminals(id)
    if (live === null) {
      return 'unreachable'
    }
    if (live > 0) {
      running.add(id)
    }
  }
  // Only a workspace that ran a terminal has one to resume, so only it counts as asleep.
  let sleptAny = false
  const ended = (outcome: WslMoveHostCopyOutcome): WslMoveHostCopyStop =>
    sleptAny ? { outcome, slept: true } : outcome
  for (const id of hostWorkspaceIds) {
    const slept = await port.sleepWorkspace(id)
    if (slept === null) {
      return ended('unreachable')
    }
    sleptAny ||= slept && running.has(id)
  }
  // A slow but healthy host with many workspaces may spend the budget sleeping them.
  const exitDeadline = Math.max(deadline, now() + MIN_EXIT_WAIT_MS)
  for (;;) {
    let stillRunning = 0
    for (const id of hostWorkspaceIds) {
      const live = await port.liveTerminals(id)
      if (live === null) {
        return ended('unreachable')
      }
      stillRunning += live
    }
    if (stillRunning === 0) {
      return ended('stopped')
    }
    if (now() >= exitDeadline) {
      return ended('still-running')
    }
    await port.wait(EXIT_POLL_MS)
  }
}
