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
// Why: Codex skips marker-gated command delivery; this only bounds older daemon/local paths that still report shell-ready for Codex.
export const CODEX_SHELL_READY_TIMEOUT_MS = 300
const KILL_TIMEOUT_MS = 5_000
export const IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS = 8_000
export const SESSION_FORCE_KILL_RETRY_MS = 250
const SESSION_FORCE_KILL_MAX_ATTEMPTS = 2
// Why: bounds in-memory pending output when no client drains it; past the cap we drop records and flag
// overflow so the next take falls back to one full snapshot. UTF-16 units; worst-case wire is ~6x, under NDJSON_MAX_LINE_BYTES (16MB).
const PENDING_OUTPUT_MAX_BYTES = 2 * 1024 * 1024
// Why: pause is a fire-and-forget notify, so a resume can be lost (main crash, dropped socket); a lost
// resume must never wedge a shell, so auto-resume after this window — a still-flooded main re-pauses.
export const PRODUCER_PAUSE_FAILSAFE_MS = 5_000

export type SubprocessHandle = {
  pid: number
  /** Live foreground process name of the PTY (node-pty's `.process`), e.g.
   *  'claude' / 'codex' / 'zsh'. Null once the child has exited. */
  getForegroundProcess(): string | null
  /** Await process-table evidence captured after this confirmation request. */
  confirmForegroundProcess?(): Promise<string | null>
  /** True when shell launch args already delivered the startup command, so the host skips its stdin fallback write. */
  startupCommandDeliveredInShellArgs?: boolean
  /** Shell the subprocess actually spawned, after fallbacks. The host reconciles the caller's shell-ready
   *  assumption against it so a fallback shell without a ready marker never gates startup commands. */
  shellPath?: string
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Stop reading the PTY fd (node-pty pause()) so a flooding child blocks on write. Optional:
   *  handles that cannot pause omit it and flow control degrades to a no-op. */
  pause?(): void
  resume?(): void
  /** Resync the native PTY's screen state after a frontend clear. No-op except on Windows/ConPTY,
   *  where a stale cursor row makes the next prompt repaint below a blank gap. */
  clear?(): void
  kill(): void
  forceKill(): void
  signal(sig: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
  /** Release the native PTY handle via node-pty's destroy(). Idempotent; safe to call after exit. */
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
  // Fired once the session reaches a terminal state so the owner (TerminalHost) can reap it; without
  // a reaper, dead sessions and their scrollback emulators accumulate for the daemon's lifetime.
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
      // No onData: the daemon emulator must never reply to query sequences — the renderer's xterm is
      // the authoritative responder and a daemon reply would race ahead and clobber it. See HeadlessEmulator.
    })
    // Why: seed recovery must precede listener registration; shells can emit their prompt synchronously once onData subscribes.
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
    // Why: a paused child can be blocked inside write(); resume before any async snapshot so it handles termination promptly.
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

    // Why: keep queuing during the post-ready flush-gate window ('ready' but not yet flushed); a
    // direct write would race fresh input ahead of the buffered startup command.
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
    // Why: the record stream must mirror the emulator's apply order, or cold-restore replay reflows at the wrong point.
    this.recordPendingOutput({ kind: 'resize', cols, rows })
    this.subprocess.resize(cols, rows)
  }

  /** Producer-side flow control: stop reading the PTY fd so a flooding child blocks on write.
   *  Arms the lost-resume failsafe; re-pausing re-arms it. */
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
      // Why: agent tool children live in detached process groups a dying shell's SIGHUP never reaches, so sweep them.
      void Promise.resolve(
        killWithDescendantSweep(
          this.subprocess.pid,
          () => {
            this.signalTerminationRoot()
          },
          {
            // Why: if the root exits during ps its PID can be recycled; never apply that stale snapshot to a different process tree.
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
      // Why: a rejected signal is not termination; reopen the session so a later retry can still target the live child.
      this.resetTerminationAfterSignalFailure()
      throw error
    }
  }

  /** Starts the graceful-kill deadline when a coordinator owns the snapshot-first portion of teardown. */
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
          // Why: a transient SIGKILL rejection must not consume the only fallback owner after graceful shutdown returned.
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
    // Why: escalate a graceful termination now; waiting for the 5s timer would spend most of the physical-exit budget.
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
    // Why: with no attached client nobody will send resumePty, so a paused shell would wedge until the failsafe; resume eagerly.
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

  // Why: returns the size the PTY actually applied (emulator dims) so the renderer can detect a
  // resize dropped here (exited/disposed/invalid) instead of trusting its last-requested size.
  getAppliedSize(): { cols: number; rows: number } | null {
    if (this._disposed) {
      return null
    }
    return this.emulator.getAppliedSize()
  }

  /** Drains records accumulated since the last take. When includeSnapshot is set it serializes in
   *  the same turn so no PTY data lands between drain and snapshot (which would replay twice on cold restore). */
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

  /** Why: ConPTY's buffer clear leaves PSReadLine's cached cursor row stale, so the next prompt
   *  repaints below a blank gap; a form feed (Ctrl+L) forces a repaint at the true origin. Gated to a
   *  PowerShell foreground (else a running command/TUI gets a stray 0x0C) and an empty prompt (PSReadLine
   *  repaints pending input at a stale cached row ConPTY's fixed viewport doesn't track). */
  #nudgePowerShellPromptRepaint(): void {
    if (process.platform !== 'win32') {
      return
    }
    // Why: before shell-ready, write() would queue this form feed behind the startup command and
    // fire it later when the gates below are stale; the nudge is cosmetic, so skip rather than defer.
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

    // Why: `wasTerminating` below must be read BEFORE the `_state = 'exited'` flip — it guards the
    // "dispose while kill() in flight" case and the invariant needs the pre-flip `_state`; do NOT move it down.
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

  /** fd-release-only teardown for ALREADY-exited sessions still retained in the host map; skips
   *  SIGKILL, so callers MUST NOT use it on live sessions. Separate method because a reaped pid is
   *  eligible for POSIX reuse, so SIGKILL could otherwise hit an unrelated process. */
  disposeSubprocess(): void {
    this.#teardownSubprocess()
    this._state = 'exited'
  }

  /** Orderly-shutdown path (TerminalHost.dispose()) for live sessions: force-kills the child, then
   *  synchronously frees the ptmx fd, bypassing the 5s KILL_TIMEOUT_MS fallback. Does NOT fan out
   *  onExit (renderer reconnects cold after daemon exit). Callers MUST check isAlive first. */
  async forceKillAndDisposeSubprocess(): Promise<void> {
    // Why: daemon exit can't neutralize the native handle until a bounded retry lands and onExit proves the child was reaped.
    await this.forceKillAndWaitForExit()
    this.dispose()
  }

  /** Shared teardown for dispose()/forceKillAndDisposeSubprocess(). Does NOT set `_state` — the
   *  caller owns that after capturing pre-flip invariants (see the wasTerminating capture in dispose). */
  #teardownSubprocess(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    // Why: never leave a paused fd behind on teardown; the handle's dead-guard makes this a no-op once the child is reaped.
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
      // Why: dispose() should never throw, but if it does, callers must still complete their own cleanup (fanout, map removal).
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
    // Why: coalesce the thousands of tiny TUI chunks per tick to keep take RPC/log frames compact; 64KB cap bounds append cost.
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
    // Why: absolute raw count (daemon stream thinning can drop bytes) lets a snapshot cover the gaps while the renderer dedups the tail.
    this.outputSequence += rawLength
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
    // Why resume:false — the child is reaped (nothing to unblock); only the failsafe timer must not outlive the session.
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

    // Why: release the ptmx fd here or node-pty's _socket leaks the master fd until GC (docs/fix-pty-fd-leak.md).
    // Not via #teardownSubprocess: it flips `_disposed`, short-circuiting the later Session.dispose() reaper.
    this.disposeSubprocessHandle()

    for (const client of this.attachedClients) {
      client.onExit(code)
    }

    // Why: hand off to the owner's reaper (disposes emulator, drops session from host map); else dead sessions accumulate.
    this.onSessionExit?.(code)
  }

  private releaseHeldShellReadyBytes(): string {
    if (!this.shellReadyScanState) {
      return ''
    }
    const heldBytes = drainShellReadyHeldBytes(this.shellReadyScanState)
    this.shellReadyScanState = null
    // Why: scanning strips marker bytes before fan-out; if readiness never completes, release any held prefix before timeout/exit discards it.
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
    // Why: timed-out destructive retries must detach from an unkillable child, else each retry stays retained until it exits.
    return this.physicalExit.waitForExit(
      timeoutMs,
      () => new Error(`Timed out waiting for PTY process exit: ${this.sessionId}`)
    )
  }
}
