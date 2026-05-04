/* oxlint-disable max-lines */
import { HeadlessEmulator } from './headless-emulator'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import { PostReadyFlushGate } from './post-ready-flush-gate'
import type { SessionState, ShellReadyState, TerminalSnapshot } from './types'

const SHELL_READY_TIMEOUT_MS = 15_000
const KILL_TIMEOUT_MS = 5_000
const SHELL_READY_MARKER = '\x1b]777;orca-shell-ready\x07'

export type SubprocessHandle = {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  forceKill(): void
  signal(sig: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
  /** Release the native PTY handle via node-pty's own destroy() path.
   *  Idempotent. Safe to call after exit. Called by Session on every teardown
   *  path (natural exit, kill, force-kill, native throw, session dispose). */
  dispose(): void
}

export type SessionOptions = {
  sessionId: string
  cols: number
  rows: number
  subprocess: SubprocessHandle
  shellReadySupported: boolean
  scrollback?: number
}

type AttachedClient = {
  token: symbol
  onData: (data: string) => void
  onExit: (code: number) => void
}

export class Session {
  readonly sessionId: string
  private _state: SessionState = 'running'
  private _shellState: ShellReadyState
  private _exitCode: number | null = null
  private _isTerminating = false
  private _disposed = false
  private emulator: HeadlessEmulator
  private subprocess: SubprocessHandle
  private attachedClients: AttachedClient[] = []
  private preReadyStdinQueue: string[] = []
  private markerBuffer = ''
  private shellReadyTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private postReadyFlushGate: PostReadyFlushGate

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.subprocess = opts.subprocess
    const size = normalizePtySize(opts.cols, opts.rows)
    this.emulator = new HeadlessEmulator({
      cols: size.cols,
      rows: size.rows,
      scrollback: opts.scrollback
      // No onData wiring: the daemon-side emulator must never reply to
      // terminal query sequences. The renderer's xterm is the authoritative
      // responder; any daemon reply races ahead via in-process parsing and
      // clobbers the renderer's answer. See the comment in HeadlessEmulator.
    })

    if (opts.shellReadySupported) {
      this._shellState = 'pending'
      this.shellReadyTimer = setTimeout(() => {
        this.onShellReadyTimeout()
      }, SHELL_READY_TIMEOUT_MS)
    } else {
      this._shellState = 'unsupported'
    }

    this.postReadyFlushGate = new PostReadyFlushGate(() => this.flushPreReadyQueue())
    this.subprocess.onData((data) => this.handleSubprocessData(data))
    this.subprocess.onExit((code) => this.handleSubprocessExit(code))
  }

  get state(): SessionState {
    return this._state
  }

  get shellState(): ShellReadyState {
    return this._shellState
  }

  get exitCode(): number | null {
    return this._exitCode
  }

  get isAlive(): boolean {
    return this._state !== 'exited'
  }

  get isTerminating(): boolean {
    return this._isTerminating
  }

  get pid(): number {
    return this.subprocess.pid
  }

  write(data: string): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }

    // Why: during the post-ready flush gate window (shellState is already
    // 'ready' but the queue hasn't flushed yet) we must keep queuing. Writing
    // directly would let fresh input race ahead of the buffered startup
    // command, changing execution order.
    if (this._shellState === 'pending' || this.postReadyFlushGate.isPending) {
      this.preReadyStdinQueue.push(data)
      return
    }

    this.subprocess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    if (!isValidPtySize(cols, rows)) {
      return
    }
    this.emulator.resize(cols, rows)
    this.subprocess.resize(cols, rows)
  }

  kill(): void {
    if (this._state === 'exited' || this._isTerminating) {
      return
    }
    this._isTerminating = true

    this.subprocess.kill()

    this.killTimer = setTimeout(() => {
      if (this._state !== 'exited') {
        this.forceDispose()
      }
    }, KILL_TIMEOUT_MS)
  }

  signal(sig: string): void {
    if (this._state === 'exited') {
      return
    }
    this.subprocess.signal(sig)
  }

  attachClient(client: { onData: (data: string) => void; onExit: (code: number) => void }): symbol {
    const token = Symbol('attach')
    this.attachedClients.push({ token, ...client })
    return token
  }

  detachClient(token: symbol): void {
    const idx = this.attachedClients.findIndex((c) => c.token === token)
    if (idx !== -1) {
      this.attachedClients.splice(idx, 1)
    }
  }

  detachAllClients(): void {
    this.attachedClients.length = 0
  }

  getSnapshot(): TerminalSnapshot | null {
    if (this._disposed) {
      return null
    }
    return this.emulator.getSnapshot()
  }

  getCwd(): string | null {
    return this.emulator.getCwd()
  }

  clearScrollback(): void {
    if (this._disposed) {
      return
    }
    this.emulator.clearScrollback()
  }

  dispose(): void {
    if (this._disposed) {
      return
    }

    // Why: captured BEFORE the `_state = 'exited'` flip below. This check
    // guards the "dispose while kill() was already in flight" case — if true,
    // the child hasn't reaped yet and we need to forceKill it here (the 5s
    // killTimer is also about to be cleared by #teardownSubprocess). Do NOT
    // move this capture below #teardownSubprocess or the `_state = 'exited'`
    // assignment — #teardownSubprocess flips `_disposed` but the invariant
    // depends on the PRE-flip value of `_state`.
    const wasTerminating = this._isTerminating && this._state !== 'exited'
    const clientsToNotify = wasTerminating ? this.attachedClients.slice() : []
    if (wasTerminating) {
      try {
        this.subprocess.forceKill()
      } catch {
        /* child may already be gone */
      }
      this._exitCode = -1
      this._isTerminating = false
    }

    this.#teardownSubprocess()
    this._state = 'exited'

    this.attachedClients = []
    this.preReadyStdinQueue = []
    this.postReadyFlushGate.clear()
    this.emulator.dispose()

    for (const client of clientsToNotify) {
      client.onExit(-1)
    }
  }

  /** Public: fd-release-only teardown for sessions that have ALREADY exited
   *  (state === 'exited') but are still retained in the host's map. Callers
   *  MUST NOT use this on live sessions — it skips SIGKILL.
   *
   *  Why a separate method: after handleSubprocessExit fires, proc.pid refers
   *  to a child that has been reaped; on POSIX that pid is eligible for reuse
   *  and may now belong to an unrelated process. forceKillAndDisposeSubprocess
   *  would send SIGKILL to that recycled pid. This method only releases the
   *  PTY master fd via node-pty's destroy() (which is neutralized against the
   *  SIGHUP-to-pid hazard by the onExit handler in pty-subprocess.ts). */
  disposeSubprocess(): void {
    this.#teardownSubprocess()
    this._state = 'exited'
  }

  /** Public: orderly-shutdown path used by TerminalHost.dispose() for sessions
   *  that are still live. Force-kills the child (SIGKILL is not ignorable),
   *  then releases the PTY master fd synchronously via node-pty's destroy().
   *  Bypasses the 5s KILL_TIMEOUT_MS fallback so daemon shutdown reaps
   *  stubborn children AND frees the ptmx fd on the same tick. Does NOT fan
   *  out onExit to attached clients — renderer reconnects cold after daemon
   *  exit. Callers MUST check isAlive first; see disposeSubprocess() for the
   *  already-exited case. */
  forceKillAndDisposeSubprocess(): void {
    // Why: forceKill before #teardownSubprocess. The helper's subprocess.dispose()
    // neutralizes node-pty's proc.kill on POSIX (to kill the SIGHUP-to-recycled-pid
    // hazard). subprocess.forceKill uses process.kill(pid, 'SIGKILL') directly
    // (pty-subprocess.ts) — unaffected by the neutralization, because it does not
    // go through proc.kill. SIGKILL is not ignorable; any child that would have
    // survived the 5s timer is reaped immediately.
    try {
      this.subprocess.forceKill()
    } catch {
      /* swallow — child may already be gone */
    }
    this.#teardownSubprocess()
    this._state = 'exited'
  }

  /** Private: shared teardown helper called by dispose(), forceDispose(), and
   *  forceKillAndDisposeSubprocess(). Flips `_disposed`, clears pending timers,
   *  and forwards to subprocess.dispose() exactly once. Does NOT set `_state` —
   *  the caller owns the state transition AFTER capturing any invariants that
   *  depend on the pre-flip value (see the wasTerminating capture in dispose). */
  #teardownSubprocess(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
    try {
      this.subprocess.dispose()
    } catch (err) {
      // Why: dispose() is documented never to throw, but if it does we must not
      // prevent callers from completing their own cleanup (fanout, map removal).
      console.warn('[Session] subprocess.dispose() threw:', err)
    }
  }

  private handleSubprocessData(data: string): void {
    if (this._disposed) {
      return
    }

    // Feed data to headless emulator for state tracking
    this.emulator.write(data)

    if (this._shellState === 'pending') {
      this.scanForShellMarker(data)
    } else {
      this.postReadyFlushGate.notifyData()
    }

    // Broadcast to attached clients
    for (const client of this.attachedClients) {
      client.onData(data)
    }
  }

  private handleSubprocessExit(code: number): void {
    if (this._disposed) {
      return
    }

    this._exitCode = code
    this._state = 'exited'

    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
    this.postReadyFlushGate.clear()

    // Why: release the ptmx fd on the natural-exit path. Without this, the
    // node-pty wrapper's _socket stays alive until GC and the master fd leaks
    // (see docs/fix-pty-fd-leak.md). Do NOT route through #teardownSubprocess:
    // that helper flips `_disposed = true`, which would short-circuit a later
    // Session.dispose() call from TerminalHost's dead-session cleanup at
    // terminal-host.ts:83 — skipping attachedClients/emulator/postReadyFlushGate
    // cleanup. Call subprocess.dispose() directly inside try/catch.
    try {
      this.subprocess.dispose()
    } catch {
      /* swallow — must not prevent exit-code fanout below */
    }

    for (const client of this.attachedClients) {
      client.onExit(code)
    }
  }

  private scanForShellMarker(data: string): void {
    this.markerBuffer += data

    const markerIdx = this.markerBuffer.indexOf(SHELL_READY_MARKER)
    if (markerIdx !== -1) {
      this.markerBuffer = ''
      this.transitionToReady()
      return
    }

    // Keep only the tail that could be the start of a partial marker match
    const maxPartial = SHELL_READY_MARKER.length - 1
    if (this.markerBuffer.length > maxPartial) {
      this.markerBuffer = this.markerBuffer.slice(-maxPartial)
    }
  }

  private transitionToReady(): void {
    this._shellState = 'ready'
    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
    if (this.preReadyStdinQueue.length === 0) {
      return
    }
    this.postReadyFlushGate.arm()
  }

  private onShellReadyTimeout(): void {
    this.shellReadyTimer = null
    if (this._shellState !== 'pending') {
      return
    }
    this._shellState = 'timed_out'
    this.flushPreReadyQueue()
  }

  private flushPreReadyQueue(): void {
    const queued = this.preReadyStdinQueue
    this.preReadyStdinQueue = []
    for (const data of queued) {
      this.subprocess.write(data)
    }
  }

  private forceDispose(): void {
    if (this._state === 'exited') {
      return
    }
    // Why: forceKill BEFORE #teardownSubprocess. Order is load-bearing — the
    // helper's subprocess.dispose() neutralizes proc.kill on POSIX (to defuse
    // the SIGHUP-to-recycled-pid hazard inside node-pty). forceKill uses
    // process.kill(pid, 'SIGKILL') directly and is unaffected by that
    // neutralization. Must NOT flip `_disposed` here before #teardownSubprocess
    // runs, or the helper would early-return and skip subprocess.dispose() —
    // the ptmx fd would leak on every kill-timeout (this whole doc's target).
    try {
      this.subprocess.forceKill()
    } catch {
      /* already dead */
    }
    this._exitCode = -1
    this._isTerminating = false

    this.#teardownSubprocess()
    this._state = 'exited'

    const clients = this.attachedClients
    this.attachedClients = []
    this.preReadyStdinQueue = []
    this.postReadyFlushGate.clear()
    this.emulator.dispose()

    for (const client of clients) {
      client.onExit(-1)
    }
  }
}
