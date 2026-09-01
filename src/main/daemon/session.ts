import { isValidPtySize } from './daemon-pty-size'
import { SessionOutputPlane, type AttachedClient } from './session-output-plane'
import { SessionProducerPause } from './session-producer-pause'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import {
  SessionTerminationController,
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS
} from './session-termination-controller'
import { nudgePowerShellPromptRepaint } from './session-powershell-prompt-repaint'
import {
  releaseSessionSubprocess,
  runSessionDispose,
  runSessionPhysicalExit,
  type SessionTeardownHost
} from './session-teardown-sequence'
export type { SubprocessHandle } from './session-subprocess-handle'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { JobTerminationOutcome } from '../windows/windows-pty-job'
import type { SessionOptions } from './session-options'
import type { TuiAgent } from '../../shared/tui-agent'
import { randomUUID } from 'node:crypto'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'

import type {
  SessionState,
  ShellReadyState,
  TakePendingOutputResult,
  TerminalSnapshot
} from './types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

export class Session {
  readonly sessionId: string
  readonly incarnationId = randomUUID()
  readonly terminalHandle: string | null
  readonly launchAgent: TuiAgent | null
  readonly launchToken: string | null
  readonly wslDistro: string | null
  private _state: SessionState = 'running'
  private _exitCode: number | null = null
  private _disposed = false
  private subprocess: SubprocessHandle
  private readonly onSessionExit?: (code: number) => void
  private readonly output: SessionOutputPlane
  private readonly producerPause: SessionProducerPause
  private readonly shellReady: SessionShellReadyBarrier
  private readonly termination: SessionTerminationController
  private readonly startupIngress: PtyStartupIngress

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.terminalHandle = opts.terminalHandle ?? null
    this.launchAgent = opts.launchAgent ?? null
    this.launchToken = opts.launchToken ?? null
    this.wslDistro = opts.wslDistro ?? null
    this.subprocess = opts.subprocess
    this.onSessionExit = opts.onExit
    this.output = new SessionOutputPlane({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback,
      wslDistro: opts.wslDistro,
      historySeedChunks: opts.historySeedChunks
    })
    this.producerPause = new SessionProducerPause(this.subprocess)
    this.termination = new SessionTerminationController({
      sessionId: this.sessionId,
      subprocess: this.subprocess,
      launchAgent: this.launchAgent,
      isExited: () => this._state === 'exited',
      releaseProducerPause: (pauseOpts) => this.producerPause.release(pauseOpts)
    })

    this.shellReady = new SessionShellReadyBarrier({
      sessionId: this.sessionId,
      subprocess: this.subprocess,
      responderParser: this.output.responderParser,
      shellReadySupported: opts.shellReadySupported,
      ...(opts.reportReadinessEvent ? { reportReadinessEvent: opts.reportReadinessEvent } : {}),
      shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
      installDeviceAttributesFilter: () => this.output.installDeviceAttributesFilter(),
      releaseDeviceAttributesFilter: () => this.output.releaseDeviceAttributesFilter(),
      acceptStartupIngress: (data) => this.startupIngress.accept(data)
    })

    this.startupIngress = new PtyStartupIngress({
      ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
      ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
      write: (data) => this.subprocess.write(data),
      onEmission: (emission) => this.output.emit(emission)
    })
    this.shellReady.startPromptReadinessProbe()
    this.subprocess.onData((data) => this.handleSubprocessData(data))
    this.subprocess.onExit((code, cause) => this.handleSubprocessExit(code, cause))
  }

  get state(): SessionState {
    return this._state
  }

  get shellState(): ShellReadyState {
    return this.shellReady.state
  }

  get historySeeded(): boolean | undefined {
    return this.output.historySeeded
  }

  get exitCode(): number | null {
    return this._exitCode
  }

  get isAlive(): boolean {
    return this._state !== 'exited'
  }

  /** A viewing client is attached; a dropped transport must clear this or pause/resume semantics leak. */
  get hasAttachedClients(): boolean {
    return this.output.hasAttachedClients
  }

  get isTerminating(): boolean {
    return this.termination.isTerminating
  }

  /** Claims termination synchronously so attach/re-entry cannot race async
   * teardown preparation. Returns false when another owner already claimed it. */
  beginTermination(): boolean {
    return this.termination.beginTermination()
  }

  get pid(): number {
    return this.subprocess.pid
  }

  /** Terminate this session's pty job object. `unavailable` is not proof of death. */
  terminateOwnedTree(): JobTerminationOutcome {
    return this.subprocess.terminateOwnedTree()
  }

  write(data: string): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }

    // Daemon POSIX PTYs need the local provider's cooked-echo containment (#13137).
    // DA1/CPR stay immediate unless an echo-risk reply is already held (#13892, #15559).
    if (this.startupIngress.answerLiveQueryReply(data)) {
      return
    }

    // Why: keep queuing during the post-ready flush-gate window ('ready' but not yet flushed); a
    // direct write would race fresh input ahead of the buffered startup command.
    if (this.shellReady.tryEnqueue(data)) {
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
    this.output.resize(cols, rows)
    this.subprocess.resize(cols, rows)
  }

  /** Producer-side flow control: stop reading the PTY fd so a flooding child blocks on write.
   *  Arms the lost-resume failsafe; re-pausing re-arms it. */
  pauseProducer(): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    this.producerPause.pause()
  }

  resumeProducer(): void {
    this.producerPause.release({ resume: true })
  }

  kill(): void {
    this.termination.kill()
  }

  /** Signals a root whose descendant snapshot has completed. */
  signalTerminationRoot(): void {
    this.termination.signalTerminationRoot()
  }

  /** Starts the graceful-kill deadline when a coordinator owns the snapshot-first portion of teardown. */
  scheduleForceDisposeFallback(): void {
    this.termination.scheduleForceDisposeFallback()
  }

  async forceKillAndWaitForExit(
    timeoutMs = IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS
  ): Promise<void> {
    await this.termination.forceKillAndWaitForExit(timeoutMs)
  }

  signal(sig: string): void {
    this.termination.signal(sig)
  }

  attachClient(client: Omit<AttachedClient, 'token'>): symbol {
    return this.output.attachClient(client)
  }

  detachClient(token: symbol): void {
    this.output.detachClient(token)
    // Why: with no attached client nobody will send resumePty, so a paused shell would wedge until the failsafe; resume eagerly.
    if (!this.output.hasAttachedClients) {
      this.producerPause.release({ resume: true })
    }
  }

  detachAllClients(): void {
    this.output.clearClients()
    this.producerPause.release({ resume: true })
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    this.startupIngress.snapshotBarrier()
    return this.output.getSnapshot(opts)
  }

  getPartialEscapeTailAnsi(): string {
    return this.output.getPartialEscapeTailAnsi()
  }

  getAppliedSize(): { cols: number; rows: number } | null {
    return this.output.getAppliedSize()
  }

  takePendingOutput(
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    if (this._disposed) {
      return null
    }
    const releasedHeldBytes =
      includeSnapshot && opts.teardownSnapshot === true ? this.prepareForFinalSnapshot() : ''
    return this.output.takePendingOutput(includeSnapshot, releasedHeldBytes, () =>
      this.getSnapshot()
    )
  }

  getCwd(): string | null {
    return this.output.getCwd()
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
    this.output.clearScrollback()
    this.subprocess.clear?.()
    nudgePowerShellPromptRepaint({
      subprocess: this.subprocess,
      isGatingWrites: this.shellReady.isGatingWrites,
      isCursorOnEmptyPromptLine: () => this.output.isCursorOnEmptyPromptLine()
    })
  }

  prepareForFinalSnapshot(): string {
    const held = this.shellReady.releaseHeldBytes()
    this.startupIngress.snapshotBarrier()
    return held
  }

  dispose(): void {
    if (this._disposed) {
      return
    }
    runSessionDispose(this.#teardownHost())
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
    releaseSessionSubprocess(this.#teardownHost())
  }

  #teardownHost(): SessionTeardownHost {
    return {
      parts: {
        subprocess: this.subprocess,
        output: this.output,
        producerPause: this.producerPause,
        shellReady: this.shellReady,
        termination: this.termination,
        startupIngress: this.startupIngress
      },
      incarnationId: this.incarnationId,
      isExited: () => this._state === 'exited',
      markExitCode: (code) => {
        this._exitCode = code
      },
      markExited: () => {
        this._state = 'exited'
      },
      releaseSubprocess: () => this.#teardownSubprocess()
    }
  }

  private handleSubprocessData(data: string): void {
    if (this._disposed) {
      return
    }
    this.shellReady.ingestSubprocessData(data)
  }

  private handleSubprocessExit(code: number, cause?: TerminalExitCause): void {
    this.termination.markPhysicalExit()
    if (this._disposed) {
      return
    }

    runSessionPhysicalExit(this.#teardownHost(), code, cause)
    // Why: hand off to the owner's reaper (disposes emulator, drops session from host map); else dead sessions accumulate.
    this.onSessionExit?.(code)
  }

  closeStartupQueryAuthority(): number {
    return this.startupIngress.closeQueryAuthority()
  }
}
