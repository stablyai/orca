/**
 * Before "Use on this computer again" resumes the project's agents here, the host's copies of its
 * terminals must have exited: an agent the move resumed on the host would otherwise keep running
 * beside the local one, two writers on one transcript (awin verify-7, 6c). Unverifiable is not
 * exited, so a host that does not answer is reported, never assumed stopped.
 */
export type WslMoveHostCopyStop = 'stopped' | 'still-running' | 'unreachable'

export type WslMoveHostCopyPort = {
  /** Sleeps the host workspace; false when the host refused, null when it did not answer. */
  sleepWorkspace: (hostWorkspaceId: string) => Promise<boolean | null>
  /** The host workspace's terminals still running; null when the host did not answer. */
  liveTerminals: (hostWorkspaceId: string) => Promise<number | null>
  wait: (ms: number) => Promise<void>
}

const EXIT_WAIT_MS = 20_000
const EXIT_POLL_MS = 500

export async function stopWslMoveHostCopies(
  hostWorkspaceIds: readonly string[],
  port: WslMoveHostCopyPort,
  exitWaitMs = EXIT_WAIT_MS
): Promise<WslMoveHostCopyStop> {
  // Why first: a host that cannot answer for every workspace must not have any of them stopped.
  for (const id of hostWorkspaceIds) {
    if ((await port.liveTerminals(id)) === null) {
      return 'unreachable'
    }
  }
  for (const id of hostWorkspaceIds) {
    const slept = await port.sleepWorkspace(id)
    if (slept === null) {
      return 'unreachable'
    }
  }
  for (let waited = 0; ; waited += EXIT_POLL_MS) {
    let running = 0
    for (const id of hostWorkspaceIds) {
      const live = await port.liveTerminals(id)
      if (live === null) {
        return 'unreachable'
      }
      running += live
    }
    if (running === 0) {
      return 'stopped'
    }
    if (waited >= exitWaitMs) {
      return 'still-running'
    }
    await port.wait(EXIT_POLL_MS)
  }
}
