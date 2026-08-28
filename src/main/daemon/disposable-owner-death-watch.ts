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
  ownerStartedAtMs: number
  onRetire: (details: {
    ownerPid: number
    cause: 'owner-exited' | 'owner-incarnation-changed' | 'owner-incarnation-unverifiable'
  }) => void
  /** Test seams; production uses real timers and a real signal-0 probe. */
  probe?: (pid: number) => void
  readStartedAtMs?: (pid: number) => Promise<number | null>
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
  private checking = false
  private readonly options: Required<DisposableOwnerDeathWatchOptions>

  constructor(options: DisposableOwnerDeathWatchOptions) {
    this.options = {
      probe: (pid) => process.kill(pid, 0),
      readStartedAtMs: async (pid) => {
        if (process.platform !== 'win32') {
          return getProcessStartedAtMs(pid)
        }
        const evidence = await queryWindowsProcess(pid)
        return evidence.status === 'present' ? evidence.startedAtMs : null
      },
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
    this.timer = this.options.setInterval(() => void this.check(), this.options.intervalMs)
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
  async check(): Promise<void> {
    if (this.retired || this.checking) {
      return
    }
    this.checking = true
    try {
      try {
        this.options.probe(this.options.ownerPid)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ESRCH') {
          this.retire('owner-exited')
        }
        return
      }
      let currentStartedAtMs: number | null
      try {
        currentStartedAtMs = await this.options.readStartedAtMs(this.options.ownerPid)
      } catch {
        currentStartedAtMs = null
      }
      if (currentStartedAtMs === null) {
        // Disposable profiles are fail-closed: an unverifiable recycled PID must
        // never keep a daemon and its writer descendants alive indefinitely.
        this.retire('owner-incarnation-unverifiable')
      } else if (
        !startTimesWithinTolerance(
          currentStartedAtMs,
          this.options.ownerStartedAtMs,
          START_TIME_TOLERANCE_MS
        )
      ) {
        this.retire('owner-incarnation-changed')
      }
    } finally {
      this.checking = false
    }
  }

  private retire(
    cause: 'owner-exited' | 'owner-incarnation-changed' | 'owner-incarnation-unverifiable'
  ): void {
    this.retired = true
    this.stop()
    this.options.onRetire({ ownerPid: this.options.ownerPid, cause })
  }
}
import { queryWindowsProcess } from './daemon-process-inspection'
import {
  getProcessStartedAtMs,
  START_TIME_TOLERANCE_MS,
  startTimesWithinTolerance
} from './daemon-process-start-time'
