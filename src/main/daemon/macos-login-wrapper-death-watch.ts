import {
  createLoginSessionWatchClock,
  type LoginSessionWatchClock
} from './login-session-watch-clock'
import {
  provesOwnedEmptyLoginWrapper,
  readPosixPtyRootSnapshot,
  type PosixPtyRootSnapshot,
  type PosixPtySessionLivenessDeps
} from '../pty/posix-pty-session-liveness'
import type { DaemonFileLog } from './daemon-file-log'

/** Startup window: login → trampoline → shell can briefly look empty on the TTY. */
export const MACOS_LOGIN_WRAPPER_STARTUP_GRACE_MS = 15_000
/** Idle poll while the session looks healthy. */
export const MACOS_LOGIN_WRAPPER_POLL_MS = 30_000
/** Recheck after first empty observation before a final ownership proof. */
export const MACOS_LOGIN_WRAPPER_EMPTY_RECHECK_MS = 5_000
const REQUIRED_CONSECUTIVE_EMPTY = 2

export type MacosLoginWrapperDeathWatchTiming = {
  startupGraceMs: number
  pollMs: number
  emptyRecheckMs: number
}

export type MacosLoginWrapperDeathWatchOptions = {
  rootPid: number
  /** Daemon PID that must still parent the login wrapper (ownership proof). */
  ownerPid: number
  /**
   * Signal only the proven wrapper PID (not a pgroup sweep).
   * Why: a peer can appear between the empty poll and kill; pgroup kill would take it too.
   */
  signalRoot: (rootPid: number) => void
  log?: DaemonFileLog
  clock?: LoginSessionWatchClock
  timing?: Partial<MacosLoginWrapperDeathWatchTiming>
  /** Async probe seam; production uses bounded `ps`. */
  probe?: (rootPid: number) => Promise<PosixPtyRootSnapshot>
  livenessDeps?: PosixPtySessionLivenessDeps
}

/**
 * Detects macOS TCC `login(1)` wrappers whose inner shell exited while login
 * still holds the PTY (#13764). Probes are async, non-overlapping, and fail
 * closed; a stop/exit mid-probe suppresses kill and log side effects.
 */
export class MacosLoginWrapperDeathWatch {
  private readonly rootPid: number
  private readonly ownerPid: number
  private readonly signalRoot: (rootPid: number) => void
  private readonly log: DaemonFileLog | undefined
  private readonly clock: LoginSessionWatchClock
  private readonly startupGraceMs: number
  private readonly pollMs: number
  private readonly emptyRecheckMs: number
  private readonly probe: (rootPid: number) => Promise<PosixPtyRootSnapshot>
  private readonly startedAtMs: number

  private timer: unknown = null
  private stopped = false
  private reaped = false
  private probeInFlight = false
  private consecutiveEmpty = 0

  constructor(opts: MacosLoginWrapperDeathWatchOptions) {
    this.rootPid = opts.rootPid
    this.ownerPid = opts.ownerPid
    this.signalRoot = opts.signalRoot
    this.log = opts.log
    this.clock = opts.clock ?? createLoginSessionWatchClock()
    this.startupGraceMs = opts.timing?.startupGraceMs ?? MACOS_LOGIN_WRAPPER_STARTUP_GRACE_MS
    this.pollMs = opts.timing?.pollMs ?? MACOS_LOGIN_WRAPPER_POLL_MS
    this.emptyRecheckMs = opts.timing?.emptyRecheckMs ?? MACOS_LOGIN_WRAPPER_EMPTY_RECHECK_MS
    this.probe =
      opts.probe ??
      ((rootPid) =>
        readPosixPtyRootSnapshot(rootPid, {
          ...opts.livenessDeps,
          currentPid: opts.livenessDeps?.currentPid ?? opts.ownerPid
        }))
    this.startedAtMs = this.clock.now()
  }

  start(): void {
    if (this.stopped || this.reaped) {
      return
    }
    this.schedule(this.startupGraceMs)
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer()
    if (this.stopped || this.reaped) {
      return
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.reaped || this.probeInFlight) {
      return
    }
    if (this.clock.now() - this.startedAtMs < this.startupGraceMs) {
      this.schedule(this.startupGraceMs - (this.clock.now() - this.startedAtMs))
      return
    }

    this.probeInFlight = true
    let snapshot: PosixPtyRootSnapshot
    try {
      snapshot = await this.probe(this.rootPid)
    } catch {
      snapshot = {
        liveness: 'unknown',
        rootPid: this.rootPid,
        ppid: null,
        tty: null,
        command: null
      }
    } finally {
      this.probeInFlight = false
    }

    // Why: stop/onExit during the await must not kill or log after the session is gone.
    if (this.stopped || this.reaped) {
      return
    }

    if (snapshot.liveness === 'gone') {
      this.stop()
      return
    }
    if (snapshot.liveness === 'live' || snapshot.liveness === 'unknown') {
      this.consecutiveEmpty = 0
      this.schedule(this.pollMs)
      return
    }

    this.consecutiveEmpty++
    if (this.consecutiveEmpty < REQUIRED_CONSECUTIVE_EMPTY) {
      this.log?.log('macos-login-wrapper-empty-observed', {
        rootPid: this.rootPid,
        observations: this.consecutiveEmpty
      })
      this.schedule(this.emptyRecheckMs)
      return
    }

    await this.attemptReap()
  }

  private async attemptReap(): Promise<void> {
    if (this.stopped || this.reaped || this.probeInFlight) {
      return
    }

    // Why: re-sample immediately before signal; the second empty poll is already stale.
    this.probeInFlight = true
    let finalSnapshot: PosixPtyRootSnapshot
    try {
      finalSnapshot = await this.probe(this.rootPid)
    } catch {
      finalSnapshot = {
        liveness: 'unknown',
        rootPid: this.rootPid,
        ppid: null,
        tty: null,
        command: null
      }
    } finally {
      this.probeInFlight = false
    }

    if (this.stopped || this.reaped) {
      return
    }

    if (finalSnapshot.liveness === 'gone') {
      this.stop()
      return
    }

    if (
      !provesOwnedEmptyLoginWrapper(finalSnapshot, {
        rootPid: this.rootPid,
        ownerPid: this.ownerPid
      })
    ) {
      // Work reappeared, ownership uncertain, or PID reused — never signal.
      this.consecutiveEmpty = 0
      this.schedule(this.pollMs)
      return
    }

    try {
      this.signalRoot(this.rootPid)
    } catch {
      this.consecutiveEmpty = 0
      this.log?.log('macos-login-wrapper-empty-reap-failed', { rootPid: this.rootPid })
      this.schedule(this.pollMs)
      return
    }

    // Why: reaped is proof of a successful signal, not of intent to kill.
    this.reaped = true
    this.clearTimer()
    this.log?.log('macos-login-wrapper-empty-reaped', {
      rootPid: this.rootPid,
      observations: this.consecutiveEmpty
    })
  }
}
