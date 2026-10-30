import type { ChildProcessVerdictRead, SubprocessHandle } from './session-subprocess-handle'

export abstract class SessionProcessInspection {
  constructor(protected readonly subprocess: SubprocessHandle) {}

  get pid(): number {
    return this.subprocess.pid
  }

  inspectChildProcesses(fresh?: boolean, ignoreDetached?: boolean): ChildProcessVerdictRead {
    return this.subprocess.inspectChildProcesses?.(fresh, ignoreDetached) ?? 'unverifiable'
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
