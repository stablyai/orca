import { withTimeout } from '../../../shared/concurrency/promise-timeout-fallback'
import type {
  ChildProcessVerdictRead,
  ForegroundAgentIdentity,
  SubprocessHandle
} from './session-subprocess-handle'
import type { TerminalForegroundSample } from '../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import { SessionLaunchNote } from './session-launch-note'
import { SessionRepaintNudge } from './session-repaint-nudge'

export abstract class SessionProcessInspection {
  /** Main's launch note for this process; Session feeds it the output that can retire it. */
  readonly launchNote = new SessionLaunchNote()

  readonly processNameIsSpawnFile: boolean
  readonly shellIsRootChild: boolean

  protected readonly repaintNudge = new SessionRepaintNudge()
  /** PTY output chunks seen, so idle-shell proofs can tell whether the pane printed since. */
  protected _outputChunks = 0
  /** Input writes accepted, so a proof taken before a keystroke cannot vouch for what it started. */
  protected _inputWrites = 0
  /** Wall-clock time of the latest output or input, so a capture older than it cannot vouch for the pane. */
  protected _lastActivityAt = 0

  abstract get isAlive(): boolean
  abstract getAppliedSize(): { cols: number; rows: number } | null

  constructor(protected readonly subprocess: SubprocessHandle) {
    this.processNameIsSpawnFile = subprocess.processNameIsSpawnFile === true
    this.shellIsRootChild = subprocess.shellIsRootChild === true
  }

  /** Redraws the program without input by moving only the PTY, never the grid attaches read. */
  requestRepaint(): void {
    // WinPTY redraws its own scraped screen on a resize, so its bytes would not be the program's paint.
    if (this.isAlive && this.subprocess.resizeRedrawsOwnScreen !== true) {
      this.repaintNudge.request(
        () => this.getAppliedSize(),
        (cols, rows) => this.subprocess.resize(cols, rows),
        () => this.isAlive
      )
    }
  }

  inspectChildProcesses(
    fresh?: boolean,
    ignoreDetached?: boolean,
    jobMembershipOnly?: boolean
  ): ChildProcessVerdictRead {
    return (
      this.subprocess.inspectChildProcesses?.(fresh, ignoreDetached, jobMembershipOnly) ??
      'unverifiable'
    )
  }

  get outputChunks(): number {
    return this._outputChunks
  }

  get shellPath(): string | undefined {
    return this.subprocess.shellPath
  }

  get inputWrites(): number {
    return this._inputWrites
  }

  get lastActivityAt(): number {
    return this._lastActivityAt
  }

  protected noteOutput(): void {
    this._outputChunks += 1
    this._lastActivityAt = Date.now()
  }

  protected writeInput(data: string): void {
    this.noteInputWritten()
    this.subprocess.write(data)
  }

  /** Set by the shell-ready barrier: a held startup command counts as pending input. */
  startupInputQueued: () => boolean = () => false

  noteInputWritten(): void {
    this._inputWrites += 1
    this._lastActivityAt = Date.now()
  }

  /** The PTY's foreground process group (tcgetpgrp); undefined where the master cannot say. */
  readForegroundGroup(): number | null | undefined {
    return this.subprocess.readForegroundGroup?.()
  }

  observeForeground(): Promise<TerminalForegroundSample> {
    return (
      this.subprocess.observeForeground?.() ??
      Promise.resolve({ verdict: 'unverifiable', reason: 'source_unavailable' })
    )
  }

  getForegroundProcess(options?: { rawFallback?: boolean; cachedOnly?: boolean }): string | null {
    return this.subprocess.getForegroundProcess(options)
  }

  async settleForegroundRefresh(timeoutMs: number): Promise<void> {
    const pending = this.pendingForegroundRefresh()
    if (pending) {
      await withTimeout(pending, timeoutMs, undefined)
    }
  }

  pendingForegroundRefresh(): Promise<unknown> | null {
    return this.subprocess.pendingForegroundRefresh?.() ?? null
  }

  foregroundAgent(): ForegroundAgentIdentity | null {
    return this.subprocess.foregroundAgent?.() ?? null
  }

  async confirmForegroundProcess(context?: { decision?: boolean }): Promise<string | null> {
    return (
      this.subprocess.confirmForegroundProcess?.(context) ?? this.subprocess.getForegroundProcess()
    )
  }
}
