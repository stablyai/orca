import {
  isFinalAutomationRunStatus,
  type AutomationRun
} from '../../shared/automations/history/automation-run'

export type ShellRunTerminalBinding = {
  workspaceId: string
  paneKey: string
  ptyId: string
  incarnationId: string
}

/** Shell runs reserved by pane, waiting for their PTY registration to name its incarnation. */
export class ShellRunTerminalBindings {
  private readonly pending = new Map<string, AutomationRun>()

  remember(run: AutomationRun): void {
    if (run.completionCondition !== 'exit' || !run.workspaceId || !run.terminalPaneKey) {
      return
    }
    const key = JSON.stringify([run.workspaceId, run.terminalPaneKey])
    if (isFinalAutomationRunStatus(run.status) || run.terminalIncarnationId) {
      this.pending.delete(key)
    } else {
      this.pending.set(key, run)
    }
  }

  forget(runId: string): void {
    for (const [key, run] of this.pending) {
      if (run.id === runId) {
        this.pending.delete(key)
      }
    }
  }

  /** Claims the run reserved for this pane; null when none waits or its identity changed. */
  claim(
    binding: ShellRunTerminalBinding,
    readRun: (automationId: string, runId: string) => AutomationRun | null
  ): AutomationRun | null {
    const key = JSON.stringify([binding.workspaceId, binding.paneKey])
    const reserved = this.pending.get(key)
    if (!reserved) {
      return null
    }
    const run = readRun(reserved.automationId, reserved.id)
    if (!run || isFinalAutomationRunStatus(run.status)) {
      this.pending.delete(key)
      return null
    }
    if (
      (run.terminalPtyId && run.terminalPtyId !== binding.ptyId) ||
      (run.terminalIncarnationId && run.terminalIncarnationId !== binding.incarnationId)
    ) {
      return null
    }
    this.pending.delete(key)
    return run
  }
}
