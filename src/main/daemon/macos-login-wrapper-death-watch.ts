import {
  createLoginSessionWatchClock,
  type LoginSessionWatchClock
} from './login-session-watch-clock'
import {
  readPosixPtySessionLiveness,
  type PosixPtySessionLiveness,
  type PosixPtySessionLivenessDeps
} from '../pty/posix-pty-session-liveness'
import type { DaemonFileLog } from './daemon-file-log'

/** Startup window: login → trampoline → shell can briefly look empty on the TTY. */
export const MACOS_LOGIN_WRAPPER_STARTUP_GRACE_MS = 15_000
/** Idle poll while the session looks healthy. */
export const MACOS_LOGIN_WRAPPER_POLL_MS = 30_000
/** Recheck after first empty observation before authorizing a root kill. */
export const MACOS_LOGIN_WRAPPER_EMPTY_RECHECK_MS = 5_000
const REQUIRED_CONSECUTIVE_EMPTY = 2

export type MacosLoginWrapperDeathWatchTiming = {
  startupGraceMs: number
  pollMs: number
  emptyRecheckMs: number
}

export type MacosLoginWrapperDeathWatchOptions = {
  rootPid: number
  /** Force-kill only the already-owned PTY root via existing process-group seams. */
  forceKillRoot: () => void
  log?: DaemonFileLog
  clock?: LoginSessionWatchClock
  timing?: Partial<MacosLoginWrapperDeathWatchTiming>
  readLiveness?: (rootPid: number) => PosixPtySessionLiveness
  livenessDeps?: PosixPtySessionLivenessDeps
}

/**
 * Detects macOS TCC `login(1)` wrappers whose inner shell has exited while the
 * login session leader still holds the PTY (#13764).
 *
 * The daemon's `onExit` is wired to the PTY process, which is `login` when the
 * TCC wrapper is active — so a shell exit that leaves `login` alive never
 * reaps the session. This watch only force-kills after sustained `empty`
 * observations (root alive, no other processes on its TTY); `unknown` never
 * authorizes a kill.
 */
export class MacosLoginWrapperDeathWatch {
  private readonly rootPid: number
  private readonly forceKillRoot: () => void
  private readonly log: DaemonFileLog | undefined
  private readonly clock: LoginSessionWatchClock
  private readonly startupGraceMs: number
  private readonly pollMs: number
  private readonly emptyRecheckMs: number
  private readonly readLiveness: (rootPid: number) => PosixPtySessionLiveness
  private readonly startedAtMs: number

  private timer: unknown = null
  private stopped = false
  private reaped = false
  private consecutiveEmpty = 0

  constructor(opts: MacosLoginWrapperDeathWatchOptions) {
    this.rootPid = opts.rootPid
    this.forceKillRoot = opts.forceKillRoot
    this.log = opts.log
    this.clock = opts.clock ?? createLoginSessionWatchClock()
    this.startupGraceMs = opts.timing?.startupGraceMs ?? MACOS_LOGIN_WRAPPER_STARTUP_GRACE_MS
    this.pollMs = opts.timing?.pollMs ?? MACOS_LOGIN_WRAPPER_POLL_MS
    this.emptyRecheckMs = opts.timing?.emptyRecheckMs ?? MACOS_LOGIN_WRAPPER_EMPTY_RECHECK_MS
    this.readLiveness =
      opts.readLiveness ??
      ((rootPid) => readPosixPtySessionLiveness(rootPid, opts.livenessDeps))
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
      this.tick()
    }, delayMs)
  }

  private tick(): void {
    if (this.stopped || this.reaped) {
      return
    }
    // Why: the trampoline window can look empty before the shell attaches to the TTY.
    if (this.clock.now() - this.startedAtMs < this.startupGraceMs) {
      this.schedule(this.startupGraceMs - (this.clock.now() - this.startedAtMs))
      return
    }

    let liveness: PosixPtySessionLiveness
    try {
      liveness = this.readLiveness(this.rootPid)
    } catch {
      liveness = 'unknown'
    }

    if (liveness === 'gone') {
      // Root already reaped through the normal onExit path.
      this.stop()
      return
    }
    if (liveness === 'live') {
      this.consecutiveEmpty = 0
      this.schedule(this.pollMs)
      return
    }
    if (liveness === 'unknown') {
      // Why: never collapse "can't tell" into empty — same rule as endpoint ownership.
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

    this.log?.log('macos-login-wrapper-empty-reaped', {
      rootPid: this.rootPid,
      observations: this.consecutiveEmpty
    })
    try {
      this.forceKillRoot()
      this.reaped = true
      this.clearTimer()
    } catch {
      // Why: a rejected kill must not crash the daemon; keep observing so a later empty window can retry.
      this.consecutiveEmpty = 0
      this.log?.log('macos-login-wrapper-empty-reap-failed', { rootPid: this.rootPid })
      this.schedule(this.pollMs)
    }
  }
}
