/** Close per-runtime spawn admission between update census and server stop; time-bound it so vanished desktops cannot lock users out. */
export const TERMINAL_UPDATE_ADMISSION_CLOSED_MESSAGE =
  'This server is restarting for an update. Try again in a moment.'

export class TerminalUpdateAdmissionClosedError extends Error {
  constructor() {
    super(TERMINAL_UPDATE_ADMISSION_CLOSED_MESSAGE)
    this.name = 'TerminalUpdateAdmissionClosedError'
  }
}

export type WorktreeTerminalSpawnLeaseOptions = {
  refuseSleptWorktree?: boolean
  reattachSessionId?: string
  requireAttachOnly?: () => void
}

/** Live sessions the daemon vouches for; null when it could not answer. */
type ListLiveSessionIds = () => Promise<readonly string[] | null>

// Lazy: the daemon modules' xterm polyfill defines a global `window` on import.
async function listLiveDaemonSessionIds(): Promise<string[] | null> {
  const { listLiveDaemonPtyIds } = await import('../../../daemon/daemon-provider-state')
  return listLiveDaemonPtyIds()
}

export class TerminalUpdateAdmission {
  private closedUntilMs = 0
  private heldUntilExit = false
  private spawnsInFlight = 0
  private settledWaiters: (() => void)[] = []

  constructor(
    private readonly listLiveSessionIds: ListLiveSessionIds = listLiveDaemonSessionIds,
    private readonly now: () => number = Date.now
  ) {}

  /** Closes admission for `durationMs` (0 reopens); returns when it reopens on its own. */
  close(durationMs: number): number {
    this.closedUntilMs = durationMs > 0 ? this.now() + durationMs : 0
    return this.closedUntilMs
  }

  isClosed(): boolean {
    return this.heldUntilExit || this.closedUntilMs > this.now()
  }

  /** The server has begun to stop: nothing it starts now can outlive it, whatever a census asks. */
  holdUntilExit(): void {
    this.heldUntilExit = true
  }

  /** While closed, admit only daemon-proven live reattachments with attachOnly, so an exited session cannot spawn after the census. */
  async admit(
    reattachSessionId: string | undefined
  ): Promise<{ release: () => void; attachOnly: boolean }> {
    // Counted before any await, so a census closing admission meanwhile waits for this spawn.
    this.spawnsInFlight += 1
    let released = false
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      this.spawnsInFlight -= 1
      if (this.spawnsInFlight === 0) {
        const waiters = this.settledWaiters
        this.settledWaiters = []
        for (const resolve of waiters) {
          resolve()
        }
      }
    }
    if (!this.isClosed()) {
      return { release, attachOnly: false }
    }
    // An unanswered daemon never vouches a session alive, so that reattach is refused too.
    const live = reattachSessionId ? await this.listLiveSessionIds().catch(() => null) : null
    if (!reattachSessionId || !live?.includes(reattachSessionId)) {
      release()
      throw new TerminalUpdateAdmissionClosedError()
    }
    return { release, attachOnly: true }
  }

  /**
   * Holds `acquire`'s lease in flight too, so a census waits for it as for the spawn it guards.
   * `requireAttachOnly` runs when the spawn was admitted only as an attach.
   */
  async hold(
    reattachSessionId: string | undefined,
    acquire: () => Promise<() => void>,
    requireAttachOnly: (() => void) | undefined
  ): Promise<() => void> {
    const { release: releaseAdmission, attachOnly } = await this.admit(reattachSessionId)
    try {
      if (attachOnly) {
        requireAttachOnly?.()
      }
      const releaseLease = await acquire()
      return () => {
        releaseLease()
        releaseAdmission()
      }
    } catch (error) {
      releaseAdmission()
      throw error
    }
  }

  /** Whether every spawn admitted before the close finished within `timeoutMs`. */
  waitForSpawnsToSettle(timeoutMs: number): Promise<boolean> {
    if (this.spawnsInFlight === 0) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const settle = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.settledWaiters = this.settledWaiters.filter((waiter) => waiter !== settle)
        resolve(false)
      }, timeoutMs)
      this.settledWaiters.push(settle)
    })
  }
}
