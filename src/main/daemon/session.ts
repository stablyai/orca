/* oxlint-disable max-lines */
import { HeadlessEmulator } from './headless-emulator'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import { PostReadyFlushGate } from './post-ready-flush-gate'
import {
  createShellReadyScanState,
  drainShellReadyHeldBytes,
  scanForShellReady,
  type ShellReadyScanState
} from '../shell-ready-marker-scanner'
import { isPowerShellProcess } from '../../shared/shell-process-detection'
import type {
  PendingOutputRecord,
  SessionState,
  ShellReadyState,
  TakePendingOutputResult,
  TerminalSnapshot
} from './types'

const SHELL_READY_TIMEOUT_MS = 15_000
// Why: Codex startup skips marker-gated command delivery; this only bounds
// older daemon/local paths that still report shell-ready support for Codex.
export const CODEX_SHELL_READY_TIMEOUT_MS = 300
const KILL_TIMEOUT_MS = 5_000
// Why: pending records exist so the 5s checkpoint can persist increments
// instead of re-serializing the whole buffer. If no client drains them (main
// process gone, history disabled), memory must stay bounded — past the cap we
// drop the records and flag overflow so the next take falls back to one full
// snapshot, which subsumes everything dropped.
// Counted in UTF-16 code units (string .length), which tracks JS heap cost.
// Worst-case wire size for a full take is ~6x this (each control char
// JSON-escapes to six bytes) and must stay under NDJSON_MAX_LINE_BYTES (16MB).
const PENDING_OUTPUT_MAX_BYTES = 2 * 1024 * 1024

export type SubprocessHandle = {
  pid: number
  /** Live foreground process name of the PTY (node-pty's `.process`), e.g.
   *  'claude' / 'codex' / 'zsh'. Null once the child has exited. */
  getForegroundProcess(): string | null
  /** True when shell launch args already delivered the startup command, so the
   *  terminal host must skip its stdin fallback write. */
  startupCommandDeliveredInShellArgs?: boolean
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Resync the native PTY's own screen state after a frontend clear.
   *  No-op except on Windows/ConPTY, where a stale ConPTY cursor row makes
   *  the next prompt repaint land below a blank gap. */
  clear?(): void
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
  terminalHandle?: string
  subprocess: SubprocessHandle
  shellReadySupported: boolean
  shellReadyTimeoutMs?: number
  historySeed?: string
  scrollback?: number
  // Why: fired once the session reaches a terminal state (natural exit or
  // kill-timeout force-dispose) so the owner (TerminalHost) can reap it —
  // dispose the headless emulator and drop it from its session map. Without a
  // reaper, dead sessions (and their ~5000-row scrollback emulators) accumulate
  // for the lifetime of the long-lived daemon process.
  onExit?: (code: number) => void
}

type AttachedClient = {
  token: symbol
  onData: (data: string) => void
  onExit: (code: number) => void
}

export class Session {
  readonly sessionId: string
  readonly terminalHandle: string | null
  private _state: SessionState = 'running'
  private _shellState: ShellReadyState
  private _exitCode: number | null = null
  private _isTerminating = false
  private _disposed = false
  private emulator: HeadlessEmulator
  private subprocess: SubprocessHandle
  private readonly onSessionExit?: (code: number) => void
  private attachedClients: AttachedClient[] = []
  private preReadyStdinQueue: string[] = []
  private shellReadyScanState: ShellReadyScanState | null = null
  private shellReadyTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private postReadyFlushGate: PostReadyFlushGate
  private pendingOutputRecords: PendingOutputRecord[] = []
  private pendingOutputBytes = 0
  private pendingOutputOverflowed = false
  private pendingOutputSeq = 0
  private readonly _historySeeded: boolean | undefined

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.terminalHandle = opts.terminalHandle ?? null
    this.subprocess = opts.subprocess
    this.onSessionExit = opts.onExit
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
    // Why: recovery must precede listener registration; shells can emit their
    // prompt synchronously as soon as onData subscribes.
    this._historySeeded =
      opts.historySeed === undefined ? undefined : this.emulator.writeSync(opts.historySeed)

    if (opts.shellReadySupported) {
      this._shellState = 'pending'
      this.shellReadyScanState = createShellReadyScanState()
      this.shellReadyTimer = setTimeout(() => {
        this.onShellReadyTimeout()
      }, opts.shellReadyTimeoutMs ?? SHELL_READY_TIMEOUT_MS)
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

  get historySeeded(): boolean | undefined {
    return this._historySeeded
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
    // Why: the record stream must mirror the order operations were applied to
    // the emulator, or cold-restore replay reflows at the wrong point.
    this.recordPendingOutput({ kind: 'resize', cols, rows })
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

  // Why: the size the PTY actually applied (emulator dims, which Session.resize
  // advances atomically with the subprocess), so the renderer can detect a
  // resize that was dropped here (exited/disposed/invalid) instead of trusting
  // its own last-requested size. Null on a disposed session.
  getAppliedSize(): { cols: number; rows: number } | null {
    if (this._disposed) {
      return null
    }
    return this.emulator.getAppliedSize()
  }

  /** Drains the records accumulated since the last take. Runs synchronously —
   *  when includeSnapshot is set, the serialize happens in the same turn so no
   *  PTY data can land between the drain and the snapshot (which would later
   *  be replayed twice on cold restore). */
  takePendingOutput(
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    if (this._disposed) {
      return null
    }
    const releasedHeldBytes =
      includeSnapshot && opts.teardownSnapshot === true ? this.prepareForFinalSnapshot() : ''
    const records = this.pendingOutputRecords
    const overflowed = this.pendingOutputOverflowed
    this.pendingOutputRecords = []
    this.pendingOutputBytes = 0
    this.pendingOutputOverflowed = false
    this.pendingOutputSeq += 1
    return {
      records: includeSnapshot
        ? releasedHeldBytes
          ? [{ kind: 'output', data: releasedHeldBytes }]
          : []
        : records,
      seq: this.pendingOutputSeq,
      overflowed,
      snapshot: includeSnapshot ? this.emulator.getSnapshot() : null
    }
  }

  getCwd(): string | null {
    return this.emulator.getCwd()
  }

  getForegroundProcess(): string | null {
    return this.subprocess.getForegroundProcess()
  }

  clearScrollback(): void {
    if (this._disposed) {
      return
    }
    this.emulator.clearScrollback()
    this.recordPendingOutput({ kind: 'clear' })
    this.subprocess.clear?.()
    this.#nudgePowerShellPromptRepaint()
  }

  /** Why: ConPTY's buffer clear cannot reach PSReadLine's cached cursor row,
   *  so PowerShell's first Enter after a clear would still repaint the prompt
   *  at the stale row, leaving a blank gap. A form feed (Ctrl+L) makes
   *  PSReadLine itself repaint at the true origin. Gated to a PowerShell
   *  foreground so a running command or TUI never gets a stray 0x0C, and to
   *  an empty prompt because PSReadLine repaints pending input at a stale
   *  cached row that ConPTY's fixed viewport doesn't track. */
  #nudgePowerShellPromptRepaint(): void {
    if (process.platform !== 'win32') {
      return
    }
    // Why: before shell-ready, write() would queue the form feed behind the
    // buffered startup command and deliver it at an arbitrary later moment,
    // when the foreground/prompt gates below no longer hold. The nudge is
    // cosmetic — skip it rather than defer it.
    if (this._shellState === 'pending' || this.postReadyFlushGate.isPending) {
      return
    }
    if (!isPowerShellProcess(this.subprocess.getForegroundProcess())) {
      return
    }
    if (!this.emulator.isCursorOnEmptyPromptLine()) {
      return
    }
    this.subprocess.write('\x0c')
  }

  prepareForFinalSnapshot(): string {
    return this.releaseHeldShellReadyBytes()
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
    // Why: free the headless emulator's scrollback here too (this path skips
    // dispose()). Matches forceDispose(); reaping just drops the map entry.
    this.emulator.dispose()
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
    this.shellReadyScanState = null
    this.preReadyStdinQueue = []
    this.postReadyFlushGate.clear()
    try {
      this.subprocess.dispose()
    } catch (err) {
      // Why: dispose() is documented never to throw, but if it does we must not
      // prevent callers from completing their own cleanup (fanout, map removal).
      console.warn('[Session] subprocess.dispose() threw:', err)
    }
  }

  private recordPendingOutput(record: PendingOutputRecord): void {
    if (this.pendingOutputOverflowed) {
      return
    }
    const bytes = record.kind === 'output' ? record.data.length : 8
    if (this.pendingOutputBytes + bytes > PENDING_OUTPUT_MAX_BYTES) {
      this.pendingOutputRecords = []
      this.pendingOutputBytes = 0
      this.pendingOutputOverflowed = true
      return
    }
    // Why: TUIs emit thousands of tiny chunks between checkpoint ticks;
    // coalescing adjacent output keeps the take RPC and log frames compact.
    // The 64KB segment cap bounds per-chunk string-append cost.
    const last = this.pendingOutputRecords.at(-1)
    if (record.kind === 'output' && last?.kind === 'output' && last.data.length < 64 * 1024) {
      last.data += record.data
    } else {
      this.pendingOutputRecords.push(record)
    }
    this.pendingOutputBytes += bytes
  }

  private handleSubprocessData(data: string): void {
    if (this._disposed) {
      return
    }

    if (this._shellState === 'pending' && this.shellReadyScanState) {
      const scanned = scanForShellReady(this.shellReadyScanState, data)
      data = scanned.output
      if (scanned.matched) {
        this.transitionToReady(scanned.postMarkerBytesObserved)
      }
    } else {
      this.postReadyFlushGate.notifyData()
    }

    this.emitSubprocessOutput(data)
  }

  private emitSubprocessOutput(data: string): void {
    if (data.length === 0) {
      return
    }

    // Feed data to headless emulator for state tracking
    this.emulator.write(data)
    this.recordPendingOutput({ kind: 'output', data })

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
    this.releaseHeldShellReadyBytes()

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
    // that helper flips `_disposed = true`, which would short-circuit the later
    // Session.dispose() call from TerminalHost.reapSession (wired via onExit
    // below) — skipping attachedClients/emulator/postReadyFlushGate cleanup.
    // Call subprocess.dispose() directly inside try/catch.
    try {
      this.subprocess.dispose()
    } catch {
      /* swallow — must not prevent exit-code fanout below */
    }

    for (const client of this.attachedClients) {
      client.onExit(code)
    }

    // Why: hand off to the owner's reaper so the emulator is disposed and the
    // session dropped from the host map; otherwise dead sessions accumulate.
    this.onSessionExit?.(code)
  }

  private releaseHeldShellReadyBytes(): string {
    if (!this.shellReadyScanState) {
      return ''
    }
    const heldBytes = drainShellReadyHeldBytes(this.shellReadyScanState)
    this.shellReadyScanState = null
    // Why: daemon scanning now runs before emulator/client fan-out so marker
    // bytes can be stripped. If readiness never completes, preserve the
    // previous behavior by releasing any held prefix before timeout or exit
    // state changes discard it.
    this.emitSubprocessOutput(heldBytes)
    return heldBytes
  }

  private transitionToReady(postMarkerBytesObserved = false): void {
    this._shellState = 'ready'
    this.shellReadyScanState = null
    if (this.shellReadyTimer) {
      clearTimeout(this.shellReadyTimer)
      this.shellReadyTimer = null
    }
    if (this.preReadyStdinQueue.length === 0) {
      return
    }
    this.postReadyFlushGate.arm(postMarkerBytesObserved)
  }

  private onShellReadyTimeout(): void {
    this.shellReadyTimer = null
    if (this._shellState !== 'pending') {
      return
    }
    this._shellState = 'timed_out'
    this.releaseHeldShellReadyBytes()
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

    // Why: reap from the host map on the kill-timeout path too (emulator already
    // disposed above; reapSession's dispose() call is a no-op and just drops it).
    this.onSessionExit?.(-1)
  }
}
