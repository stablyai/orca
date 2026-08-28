/** Correction — a daemon born to a throwaway state root must not outlive it.
 *
 *  The incident: candidate runtimes were launched against disposable state roots
 *  under `/tmp`. When those apps went away — quit, crash, or SIGKILL — their
 *  daemons stayed up by design, because a daemon deliberately survives app quit
 *  so terminals stay warm for reattach. Nineteen of them did, holding
 *  twenty-five supervised agent sessions. Their state roots were then deleted,
 *  which removed the database, the socket and the pid record that were the only
 *  way to find them again. They kept writing to a shared checkout for hours.
 *
 *  A graceful-quit fix cannot cover this: the owner may never run its quit path.
 *  So the daemon watches its own owner and retires itself. There is nothing to
 *  reattach to, so retiring loses nothing that a disposable profile ever had.
 */

export type DisposableOwnerDeathWatchOptions = {
  /** The process whose death makes this daemon pointless — the runtime that
   *  spawned it and owns the throwaway state root. */
  ownerPid: number
  onRetire: (details: { ownerPid: number; cause: 'owner-exited' }) => void
  /** Test seams; production uses real timers and a real signal-0 probe. */
  probe?: (pid: number) => void
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  intervalMs?: number
}

const DEFAULT_POLL_MS = 2000

/** Why signal 0 and ESRCH specifically: it asks the kernel whether the pid
 *  exists without touching the process. EPERM means it exists under another
 *  user, which is not death; any other error means we could not tell, and
 *  "could not tell" must never retire a live daemon. Only ESRCH retires. */
export class DisposableOwnerDeathWatch {
  private timer: ReturnType<typeof setInterval> | null = null
  private retired = false
  private readonly options: Required<DisposableOwnerDeathWatchOptions>

  constructor(options: DisposableOwnerDeathWatchOptions) {
    this.options = {
      probe: (pid) => process.kill(pid, 0),
      setInterval,
      clearInterval,
      intervalMs: DEFAULT_POLL_MS,
      ...options
    }
  }

  start(): void {
    if (this.timer || this.retired) {
      return
    }
    this.timer = this.options.setInterval(() => this.check(), this.options.intervalMs)
    // Never hold the event loop open on this alone.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      this.options.clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Exposed so a test can step the watch without waiting on a timer. */
  check(): void {
    if (this.retired) {
      return
    }
    try {
      this.options.probe(this.options.ownerPid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ESRCH') {
        return
      }
      this.retired = true
      this.stop()
      this.options.onRetire({ ownerPid: this.options.ownerPid, cause: 'owner-exited' })
    }
  }
}
