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
import { killWithDescendantSweep } from '../pty-descendant-termination'
import type { TuiAgent } from '../../shared/types'
import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import {
  PtyStartupIngress,
  type PtyIngressEmission,
  type PtyStartupIngressIntent
} from '../../shared/pty-startup-ingress'
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
export const IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS = 8_000
export const SESSION_FORCE_KILL_RETRY_MS = 250
const SESSION_FORCE_KILL_MAX_ATTEMPTS = 2
// Why: pending records exist so the 5s checkpoint can persist increments
// instead of re-serializing the whole buffer. If no client drains them (main
// process gone, history disabled), memory must stay bounded — past the cap we
// drop the records and flag overflow so the next take falls back to one full
// snapshot, which subsumes everything dropped.
// Counted in UTF-16 code units (string .length), which tracks JS heap cost.
// Worst-case wire size for a full take is ~6x this (each control char
// JSON-escapes to six bytes) and must stay under NDJSON_MAX_LINE_BYTES (16MB).
const PENDING_OUTPUT_MAX_BYTES = 2 * 1024 * 1024
// Why: producer pause is requested over a fire-and-forget notification, so the
// matching resume can be lost (main crash, dropped socket). A lost resume must
// never wedge a shell: auto-resume after this window; a still-flooded main
// re-asserts the pause on its next watermark check.
export const PRODUCER_PAUSE_FAILSAFE_MS = 5_000

export type SubprocessHandle = {
  pid: number
  /** Live foreground process name of the PTY (node-pty's `.process`), e.g.
   *  'claude' / 'codex' / 'zsh'. Null once the child has exited. */
  getForegroundProcess(): string | null
  /** Await process-table evidence captured after this confirmation request. */
  confirmForegroundProcess?(): Promise<string | null>
  /** True when shell launch args already delivered the startup command, so the
   *  terminal host must skip its stdin fallback write. */
  startupCommandDeliveredInShellArgs?: boolean
  /** Shell the subprocess actually spawned, after Unix/Windows fallbacks. The
   *  host reconciles the caller's shell-ready assumption against it so a
   *  fallback shell without a ready marker never gates startup commands. */
  shellPath?: string
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Stop reading the PTY fd (node-pty pause()) so the kernel/ConPTY buffer
   *  fills and a flooding child blocks on write. Optional: handles that
   *  cannot pause simply omit it and flow control degrades to a no-op. */
  pause?(): void
  resume?(): void
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
  launchAgent?: TuiAgent
  subprocess: SubprocessHandle
  shellReadySupported: boolean
  shellReadyTimeoutMs?: number
  historySeed?: string
  scrollback?: number
  wslDistro?: string
  // Why: fired once the session reaches a terminal state (natural exit or
  // kill-timeout force-dispose) so the owner (TerminalHost) can reap it —
  // dispose the headless emulator and drop it from its session map. Without a
  // reaper, dead sessions (and their ~5000-row scrollback emulators) accumulate
  // for the lifetime of the long-lived daemon process.
  onExit?: (code: number) => void
  startupIngress?: PtyStartupIngressIntent
}

type AttachedClient = {
  token: symbol
  onData: (data: string, rawLength?: number, transformed?: boolean, seq?: number) => void
  onExit: (code: number) => void
}

export class Session {
  readonly sessionId: string
  readonly terminalHandle: string | null
  readonly launchAgent: TuiAgent | null
  readonly wslDistro: string | null
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
  private outputSequence = 0
  private producerPaused = false
  private producerPauseFailsafeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly _historySeeded: boolean | undefined
  private forceKillSent = false
  private subprocessDisposed = false
  private readonly physicalExit = new PhysicalExitTracker()
  private readonly startupIngress: PtyStartupIngress

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.terminalHandle = opts.terminalHandle ?? null
    this.launchAgent = opts.launchAgent ?? null
    this.wslDistro = opts.wslDistro ?? null
    this.subprocess = opts.subprocess
    this.onSessionExit = opts.onExit
    const size = normalizePtySize(opts.cols, opts.rows)
    this.emulator = new HeadlessEmulator({
      cols: size.cols,
      rows: size.rows,
      scrollback: opts.scrollback,
      wslDistro: opts.wslDistro
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
    this.startupIngress = new PtyStartupIngress({
      ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
      write: (data) => this.subprocess.write(data),
      onEmission: (emission) => this.emitSubprocessOutput(emission)
    })
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

  /** Claims termination synchronously so attach/re-entry cannot race async
   * teardown preparation. Returns false when another owner already claimed it. */
  beginTermination(): boolean {
    if (this._state === 'exited' || this._isTerminating) {
      return false
    }
    this._isTerminating = true
    // Why: a paused child can be blocked inside write(); resume before any
    // async snapshot so it can handle termination promptly.
    this.releaseProducerPause({ resume: true })
    return true
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

  /** Producer-side flow control: stop reading the PTY fd so the flooding
   *  child blocks on write (kernel backpressure). Arms the lost-resume
   *  failsafe; re-pausing re-arms it (main re-asserts during long floods). */
  pauseProducer(): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    this.producerPaused = true
    this.subprocess.pause?.()
    if (this.producerPauseFailsafeTimer) {
      clearTimeout(this.producerPauseFailsafeTimer)
    }
    this.producerPauseFailsafeTimer = setTimeout(() => {
      this.producerPauseFailsafeTimer = null
      this.producerPaused = false
      this.subprocess.resume?.()
    }, PRODUCER_PAUSE_FAILSAFE_MS)
  }

  resumeProducer(): void {
    this.releaseProducerPause({ resume: true })
  }

  private releaseProducerPause(opts: { resume: boolean }): void {
    if (this.producerPauseFailsafeTimer) {
      clearTimeout(this.producerPauseFailsafeTimer)
      this.producerPauseFailsafeTimer = null
    }
    if (!this.producerPaused) {
      return
    }
    this.producerPaused = false
    if (opts.resume) {
      this.subprocess.resume?.()
    }
  }

  kill(): void {
    if (!this.beginTermination()) {
      return
    }
    if (!this.launchAgent) {
      this.signalTerminationRoot()
    } else {
      // Why: agent tool children live in detached process groups a dying
      // shell's SIGHUP never reaches. The bounded snapshot briefly defers the
      // signal; the kill timer below starts now, so force-dispose timing is
      // unaffected.
      void Promise.resolve(
        killWithDescendantSweep(
          this.subprocess.pid,
          () => {
            this.signalTerminationRoot()
          },
          {
            // Why: if the root exits during ps, its numeric PID can be recycled.
            // Never apply that stale snapshot to a different process tree.
            ownsRoot: () => this.isAlive
          }
        )
      ).catch((error) => {
        if (this.isAlive) {
          this.resetTerminationAfterSignalFailure()
        }
        console.warn('[Session] descendant-aware graceful kill failed:', error)
      })
    }
    this.scheduleForceDisposeFallback()
  }

  /** Signals a root whose descendant snapshot has completed. */
  signalTerminationRoot(): void {
    if (this._state === 'exited') {
      return
    }
    try {
      this.subprocess.kill()
    } catch (error) {
      // Why: rejected signalling is not termination. Reopen the session so a
      // later graceful or destructive retry can still target the live child.
      this.resetTerminationAfterSignalFailure()
      throw error
    }
  }

  /** Starts the existing graceful-kill deadline when a coordinator owns the
   * snapshot-first portion of teardown. */
  scheduleForceDisposeFallback(): void {
    if (this.killTimer) {
      return
    }
    this.armForceKillFallback(KILL_TIMEOUT_MS, SESSION_FORCE_KILL_MAX_ATTEMPTS)
  }

  private resetTerminationAfterSignalFailure(): void {
    this._isTerminating = false
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  private armForceKillFallback(delayMs: number, attemptsRemaining: number): void {
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (this._state !== 'exited') {
        try {
          this.requestForceKill()
        } catch (error) {
          console.warn('[Session] failed to force-kill terminating subprocess:', error)
          // Why: a transient SIGKILL rejection must not consume the only
          // fallback owner after graceful shutdown has already returned.
          if (attemptsRemaining > 1) {
            this.armForceKillFallback(SESSION_FORCE_KILL_RETRY_MS, attemptsRemaining - 1)
          }
        }
      }
    }, delayMs)
  }

  async forceKillAndWaitForExit(
    timeoutMs = IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS
  ): Promise<void> {
    if (this._state === 'exited') {
      return
    }
    if (!this._isTerminating) {
      this._isTerminating = true
      this.releaseProducerPause({ resume: true })
    }
    // Why: destructive cleanup joins a graceful termination but escalates it
    // now; waiting for the 5s timer would spend most of the physical-exit budget.
    await this.requestForceKillWithRetry()
    await this.waitForPhysicalExit(timeoutMs)
  }

  signal(sig: string): void {
    if (this._state === 'exited') {
      return
    }
    this.subprocess.signal(sig)
  }

  attachClient(client: Omit<AttachedClient, 'token'>): symbol {
    const token = Symbol('attach')
    this.attachedClients.push({ token, ...client })
    return token
  }

  detachClient(token: symbol): void {
    const idx = this.attachedClients.findIndex((c) => c.token === token)
    if (idx !== -1) {
      this.attachedClients.splice(idx, 1)
    }
    // Why: with no attached client, nobody will ever send resumePty — a
    // paused shell would sit wedged until the failsafe. Resume eagerly.
    if (this.attachedClients.length === 0) {
      this.releaseProducerPause({ resume: true })
    }
  }

  detachAllClients(): void {
    this.attachedClients.length = 0
    this.releaseProducerPause({ resume: true })
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    this.startupIngress.snapshotBarrier()
    if (this._disposed) {
      return null
    }
    return { ...this.emulator.getSnapshot(opts), outputSequence: this.outputSequence }
  }

  getPartialEscapeTailAnsi(): string {
    if (this._disposed) {
      return ''
    }
    return this.emulator.partialEscapeTailAnsi
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
      snapshot: includeSnapshot ? this.getSnapshot() : null
    }
  }

  getCwd(): string | null {
    return this.emulator.getCwd()
  }

  getForegroundProcess(): string | null {
    return this.subprocess.getForegroundProcess()
  }

  async confirmForegroundProcess(): Promise<string | null> {
    return this.subprocess.confirmForegroundProcess?.() ?? this.subprocess.getForegroundProcess()
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
    const held = this.releaseHeldShellReadyBytes()
    this.startupIngress.snapshotBarrier()
    return held
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
    this.releaseHeldShellReadyBytes()
    this.startupIngress.drainAndClose()
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
  async forceKillAndDisposeSubprocess(): Promise<void> {
    // Why: daemon exit cannot neutralize the native handle until a bounded
    // retry is accepted and onExit proves the child was physically reaped.
    await this.forceKillAndWaitForExit()
    this.dispose()
  }

  /** Private: shared teardown helper called by dispose() and
   *  forceKillAndDisposeSubprocess(). Flips `_disposed`, clears pending timers,
   *  and forwards to subprocess.dispose() exactly once. Does NOT set `_state` —
   *  the caller owns the state transition AFTER capturing any invariants that
   *  depend on the pre-flip value (see the wasTerminating capture in dispose). */
  #teardownSubprocess(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    // Why: never leave a paused fd behind on any teardown path — the handle's
    // own dead-guard makes this a no-op when the child is already reaped.
    this.releaseProducerPause({ resume: true })
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
    this.disposeSubprocessHandle()
  }

  private disposeSubprocessHandle(): void {
    if (this.subprocessDisposed) {
      return
    }
    this.subprocessDisposed = true
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

    this.startupIngress.accept(data)
  }

  private emitSubprocessOutput(emission: PtyIngressEmission): void {
    const { data } = emission
    const rawLength = emission.rawEndSeq - emission.rawStartSeq
    // Why: daemon stream thinning can omit bytes before main sees them. The
    // absolute count lets an authoritative snapshot cover those gaps while
    // renderer reconciliation deduplicates any queued post-snapshot tail.
    this.outputSequence += rawLength
    // Feed data to headless emulator for state tracking
    if (data.length > 0) {
      this.emulator.write(data)
      this.recordPendingOutput({ kind: 'output', data })
    }

    // Broadcast to attached clients
    for (const client of this.attachedClients) {
      if (emission.transformed || rawLength !== data.length) {
        client.onData(data, rawLength, true, this.outputSequence)
      } else {
        client.onData(data)
      }
    }
  }

  private handleSubprocessExit(code: number): void {
    this.physicalExit.markExited()
    if (this._disposed) {
      return
    }

    this.releaseHeldShellReadyBytes()
    this.startupIngress.drainAndClose()
    this._exitCode = code
    this._state = 'exited'
    this._isTerminating = false
    // Why resume:false — the child is reaped, so there is nothing to unblock;
    // only the failsafe timer must not outlive the session.
    this.releaseProducerPause({ resume: false })

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
    this.disposeSubprocessHandle()

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
    this.startupIngress.accept(heldBytes)
    return heldBytes
  }

  closeStartupQueryAuthority(): number {
    return this.startupIngress.closeQueryAuthority()
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

  private requestForceKill(): void {
    if (this._state === 'exited' || this.forceKillSent) {
      return
    }
    this.forceKillSent = true
    try {
      this.subprocess.forceKill()
    } catch (error) {
      this.forceKillSent = false
      throw error
    }
  }

  private async requestForceKillWithRetry(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < SESSION_FORCE_KILL_MAX_ATTEMPTS; attempt++) {
      try {
        this.requestForceKill()
        return
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < SESSION_FORCE_KILL_MAX_ATTEMPTS) {
        try {
          await this.physicalExit.waitForExit(
            SESSION_FORCE_KILL_RETRY_MS,
            () => new Error(`Retrying force-kill for PTY ${this.sessionId}`)
          )
          return
        } catch {
          // The bounded waiter detached; retry the still-owned subprocess.
        }
      }
    }
    throw lastError
  }

  private waitForPhysicalExit(timeoutMs: number): Promise<void> {
    // Why: timed-out destructive retries must detach from an unkillable child;
    // otherwise every retry stays retained until the process eventually exits.
    return this.physicalExit.waitForExit(
      timeoutMs,
      () => new Error(`Timed out waiting for PTY process exit: ${this.sessionId}`)
    )
  }
}
