import type { ChildProcessVerdictRead, SubprocessHandle } from './session-subprocess-handle'
import type { TerminalForegroundSample } from '../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import { ManagedShellLifecycle } from '../../managed-shell-lifecycle'
import { randomUUID } from 'node:crypto'

export class SessionProcessInspection {
  readonly incarnationId = randomUUID()
  readonly shellLifecycle: ManagedShellLifecycle

  constructor(protected readonly subprocess: SubprocessHandle) {
    this.shellLifecycle = new ManagedShellLifecycle(
      subprocess.shellLifecycleBinding,
      subprocess.shellLifecycleStatePath
    )
  }

  get pid(): number {
    return this.subprocess.pid
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
