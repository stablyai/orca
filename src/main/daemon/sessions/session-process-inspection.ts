import type { ChildProcessVerdictRead, SubprocessHandle } from './session-subprocess-handle'
import type { TerminalForegroundSample } from '../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import { SessionLaunchNote } from './session-launch-note'

export class SessionProcessInspection {
  /** Main's launch note for this process; Session feeds it the output that can retire it. */
  readonly launchNote = new SessionLaunchNote()

  readonly processNameIsSpawnFile: boolean
  readonly shellIsRootChild: boolean

  constructor(protected readonly subprocess: SubprocessHandle) {
    this.processNameIsSpawnFile = subprocess.processNameIsSpawnFile === true
    this.shellIsRootChild = subprocess.shellIsRootChild === true
  }

  inspectChildProcesses(fresh?: boolean, ignoreDetached?: boolean): ChildProcessVerdictRead {
    return this.subprocess.inspectChildProcesses?.(fresh, ignoreDetached) ?? 'unverifiable'
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

  async confirmForegroundProcess(context?: { decision?: boolean }): Promise<string | null> {
    return (
      this.subprocess.confirmForegroundProcess?.(context) ?? this.subprocess.getForegroundProcess()
    )
  }
}
