import type { SessionTerminationController } from './session-termination-controller'
import type { SessionOutputPlane } from './session-output-plane'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { SubprocessHandle, ChildProcessVerdictRead } from './session-subprocess-handle'
export abstract class SessionProcessInspection {
  protected abstract subprocess: SubprocessHandle
  protected abstract readonly output: SessionOutputPlane
  protected abstract readonly recoveryBarrier: TerminalShellRecoveryBarrier
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

  confirmShellForeground(): Promise<boolean> {
    return this.recoveryBarrier.confirmOwnerSettled()
  }

  async settleShellOwnershipConfirmation(): Promise<void> {
    await this.recoveryBarrier.awaitProofSettled()
    // Snapshot only after the drained prompt is parsed into the model.
    await this.output.flushParsedWrites()
  }

  getPartialEscapeTailAnsi(): string {
    return this.output.getPartialEscapeTailAnsi()
  }

  getAppliedSize(): { cols: number; rows: number } | null {
    return this.output.getAppliedSize()
  }

  getCwd(): string | null {
    return this.output.getCwd()
  }

  protected abstract readonly termination: SessionTerminationController

  signalTerminationRoot(): void {
    this.termination.signalTerminationRoot()
  }

  scheduleForceDisposeFallback(): void {
    this.termination.scheduleForceDisposeFallback()
  }

  async forceKillAndWaitForExit(timeoutMs?: number): Promise<void> {
    await this.termination.forceKillAndWaitForExit(timeoutMs)
  }

  signal(sig: string): void {
    this.termination.signal(sig)
  }
}
