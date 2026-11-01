import type { ChildProcessVerdictRead, SubprocessHandle } from './session-subprocess-handle'
import type { TerminalForegroundSample } from '../../shared/terminal-foreground-observation'

export class SessionProcessInspection {
  constructor(protected readonly subprocess: SubprocessHandle) {}

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
