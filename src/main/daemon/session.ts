import { isValidPtySize } from './daemon-pty-size'
import type { SessionOutputPlane, AttachedClient } from './session-output-plane'
import { createSessionOutputPipeline } from './session-output-pipeline'
import { SessionProducerPause } from './session-producer-pause'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import { SessionTerminationController } from './session-termination-controller'
import type { ChildProcessVerdictRead, SubprocessHandle } from './session-subprocess-handle'
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
  readonly wslDistro: string | null
  readonly processNameIsSpawnFile: boolean
  private _state: SessionState = 'running'
  private _exitCode: number | null = null
  private _disposed = false
  private subprocess: SubprocessHandle
  private readonly onSessionExit?: (code: number) => void
  private readonly output: SessionOutputPlane
  private readonly producerPause: SessionProducerPause
  private readonly shellReady: SessionShellReadyBarrier
  private readonly termination: SessionTerminationController
  readonly startupIngress: PtyStartupIngress
  private readonly recoveryBarrier: TerminalShellRecoveryBarrier

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId
    this.terminalHandle = opts.terminalHandle ?? null
    this.launchAgent = opts.launchAgent ?? null
    this.wslDistro = opts.wslDistro ?? null
    this.subprocess = opts.subprocess
    this.processNameIsSpawnFile = opts.subprocess.processNameIsSpawnFile === true
    this.onSessionExit = opts.onExit
    const pipeline = createSessionOutputPipeline({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback,
      wslDistro: opts.wslDistro,
      historySeedChunks: opts.historySeedChunks,
      subprocess: this.subprocess,
      isAlive: () => !this._disposed && this._state !== 'exited'
    })
    this.output = pipeline.output
    this.recoveryBarrier = pipeline.recoveryBarrier
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
      onEmission: (emission) => this.recoveryBarrier.accept(emission)
    })
    this.shellReady.startPromptReadinessProbe()
    this.subprocess.onData((data) => {
      if (!this._disposed) {
        this.shellReady.ingestSubprocessData(data)
      }
    })
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

  get hasAttachedClients(): boolean {
    return this.output.hasAttachedClients
  }

  get isTerminating(): boolean {
    return this.termination.isTerminating
  }

  /** Claim termination before async teardown; false means exited or already claimed. */
  beginTermination(): boolean {
    return this.termination.beginTermination()
  }

  get pid(): number {
    return this.subprocess.pid
  }

  /** A PTY job result of unavailable does not prove child exit. */
  terminateOwnedTree(): JobTerminationOutcome {
    return this.subprocess.terminateOwnedTree()
  }

  write(data: string): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }

    // Contain cooked query echoes and preserve input order through the post-ready flush window.
    if (this.startupIngress.answerLiveQueryReply(data) || this.shellReady.tryEnqueue(data)) {
      return
    }

    this.subprocess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this._state === 'exited' || this._disposed || !isValidPtySize(cols, rows)) {
      return
    }
    this.output.resize(cols, rows)
    this.subprocess.resize(cols, rows)
  }

  /** Apply PTY backpressure with separate lost-resume and stream-stall protection. */
  pauseProducer(source?: 'stream', onStreamStall?: () => void): void {
    if (this._state === 'exited' || this._disposed) {
      return
    }
    this.producerPause.pause(source, this.hasAttachedClients && !this.isTerminating, onStreamStall)
  }

  resumeProducer(source?: 'stream'): void {
    this.producerPause.resumeClient(source)
  }

  kill(): void {
    this.termination.kill()
  }

  /** Signal the root only after its descendant snapshot has completed. */
  signalTerminationRoot(): void {
    this.termination.signalTerminationRoot()
  }

  /** Arm escalation after a coordinator begins snapshot-first teardown. */
  scheduleForceDisposeFallback(): void {
    this.termination.scheduleForceDisposeFallback()
  }

  async forceKillAndWaitForExit(timeoutMs?: number): Promise<void> {
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
    // With no viewer left to resume the producer, release its pause eagerly.
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
    const heldBytes =
      includeSnapshot && opts.teardownSnapshot === true ? this.prepareForFinalSnapshot() : ''
    return this.output.takePendingOutput(includeSnapshot, heldBytes, () => this.getSnapshot())
  }

  getCwd(): string | null {
    return this.output.getCwd()
  }

  inspectChildProcesses(fresh?: boolean, ignoreDetached?: boolean): ChildProcessVerdictRead {
    return this.subprocess.inspectChildProcesses?.(fresh, ignoreDetached) ?? 'unverifiable'
  }

  getForegroundProcess(options?: { rawFallback?: boolean; cachedOnly?: boolean }): string | null {
    return this.subprocess.getForegroundProcess(options)
  }

  async confirmForegroundProcess(): Promise<string | null> {
    return this.subprocess.confirmForegroundProcess?.() ?? this.subprocess.getForegroundProcess()
  }

  confirmShellForeground(): Promise<boolean> {
    return this.recoveryBarrier.confirmOwnerSettled()
  }

  async settleShellOwnershipConfirmation(): Promise<void> {
    await this.recoveryBarrier.awaitProofSettled()
    // Snapshot only after the drained prompt is parsed into the model.
    await this.output.flushParsedWrites()
  }

  clearScrollback(): void {
    this.output.clearScrollback(this.subprocess, this.shellReady.isGatingWrites)
  }

  resetInputModes(): void {
    this.output.applyInputModeGround(this.recoveryBarrier.groundInputModes())
  }

  prepareForFinalSnapshot(): string {
    const held = this.shellReady.releaseHeldBytes()
    this.startupIngress.snapshotBarrier()
    // Flush last: the ingress snapshot barrier can emit more held bytes into recovery.
    this.recoveryBarrier.flushPending()
    return held
  }

  dispose(): void {
    if (this._disposed) {
      return
    }

    // Capture termination intent before flipping the state to exited.
    this.shellReady.releaseDeviceAttributes()
    this.shellReady.releaseHeldBytes()
    this.startupIngress.drainAndClose()
    // Deliver drained recovery bytes while clients are attached and the emulator still accepts writes.
    this.recoveryBarrier.flushPending()
    const wasTerminating = this.termination.isTerminating && this._state !== 'exited'
    const clientsToNotify = wasTerminating ? this.output.snapshotClients() : []
    if (wasTerminating) {
      try {
        this.subprocess.forceKill()
      } catch {}
      this._exitCode = -1
      this.termination.clearTerminating()
    }

    this.#teardownSubprocess()
    this._state = 'exited'

    this.output.clearClients()
    this.shellReady.clearPendingWrites()
    this.recoveryBarrier.dispose()
    this.output.disposeEmulator()

    for (const client of clientsToNotify) {
      client.onExit(-1, this.incarnationId)
    }
  }

  /** Free an exited child’s handle without signalling its PID, which may have been reused. */
  disposeSubprocess(): void {
    this.#teardownSubprocess()
    this._state = 'exited'
  }

  /** Wait for physical child exit before final shutdown disposal; callers must check isAlive first. */
  async forceKillAndDisposeSubprocess(): Promise<void> {
    await this.forceKillAndWaitForExit()
    this.dispose()
  }

  /** The caller owns state changes after capturing pre-teardown termination intent. */
  #teardownSubprocess(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    this.output.markDisposed()
    this.producerPause.release({ resume: true })
    this.termination.cancelForceKillFallback()
    this.shellReady.dispose()
    this.termination.disposeSubprocessHandle()
  }

  private handleSubprocessExit(code: number, cause?: TerminalExitCause): void {
    // Preserve operator-close intent even when process exit beats the control reply.
    if (this.termination.isTerminating) {
      cause = { kind: 'operator_close' }
    }
    this.termination.markPhysicalExit()
    if (this._disposed) {
      return
    }

    this.shellReady.releaseDeviceAttributes()
    this.shellReady.disposePromptReadinessProbe()
    this.shellReady.releaseHeldBytes()
    this.startupIngress.drainAndClose()
    // Flush after ingress drains so prompts held mid-proof reach clients and history before the exit event.
    this.recoveryBarrier.flushPending()
    this._exitCode = code
    this._state = 'exited'
    this.termination.clearTerminating()
    // The child is reaped; clear pause timers without resuming its handle.
    this.producerPause.release({ resume: false })

    this.termination.cancelForceKillFallback()
    this.shellReady.clearReadyTimer()
    this.shellReady.clearFlushGate()

    // Free the native fd before GC without marking Session disposed, which would skip its reaper.
    this.termination.disposeSubprocessHandle()

    this.output.broadcastExit(code, this.incarnationId, cause)

    // Let the host release the emulator and remove the exited session from its map.
    this.onSessionExit?.(code)
  }

  closeStartupQueryAuthority(): number {
    return this.startupIngress.closeQueryAuthority()
  }
}
