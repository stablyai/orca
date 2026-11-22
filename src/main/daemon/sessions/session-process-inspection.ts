import type { ChildProcessVerdictRead, SubprocessHandle } from './session-subprocess-handle'
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

  abstract get isAlive(): boolean
  abstract getAppliedSize(): { cols: number; rows: number } | null

  constructor(protected readonly subprocess: SubprocessHandle) {
    this.processNameIsSpawnFile = subprocess.processNameIsSpawnFile === true
    this.shellIsRootChild = subprocess.shellIsRootChild === true
  }

  /** Redraws the program without input by moving only the PTY, never the grid attaches read. */
  requestRepaint(): void {
    if (this.isAlive) {
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
    await this.subprocess.settleForegroundRefresh?.(timeoutMs)
  }

  foregroundAgentPid(): number | null {
    return this.subprocess.foregroundAgentPid?.() ?? null
  }

  async confirmForegroundProcess(context?: { decision?: boolean }): Promise<string | null> {
    return (
      this.subprocess.confirmForegroundProcess?.(context) ?? this.subprocess.getForegroundProcess()
    )
  }
}
