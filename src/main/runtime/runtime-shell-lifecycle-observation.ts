import { OrcaRuntimeWithRestoredHandlePaneStart } from './terminal/surface/restored-handle-pane-start'
import type { RuntimeTerminalSummary } from '../../shared/runtime-terminal-contracts'
import { classifyTerminalProcessInspectionFailure } from '../../shared/terminal-process-inspection'
import { terminalShellLifecycleObservation } from './terminal-shell-lifecycle-observation'
import { withTimeoutResult } from './runtime-async-boundaries'

export abstract class OrcaRuntimeWithShellLifecycleObservation extends OrcaRuntimeWithRestoredHandlePaneStart {
  protected abstract assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void

  protected async shellLifecycleForTerminal(handle: string, summary: RuntimeTerminalSummary) {
    const unknown = (reason: string) =>
      terminalShellLifecycleObservation(summary, this.getRuntimeId(), null, reason)
    const controller = this.ptyController
    const ptyId = summary.ptyId
    if (!ptyId || !summary.incarnationId || !summary.connected || !summary.executionHostId) {
      return unknown('incomplete-identity')
    }
    if (!controller?.inspectProcess) {
      return unknown('old-host')
    }
    const record = this.ptysById.get(ptyId)
    const incarnationId = summary.incarnationId
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const started = performance.now()
    try {
      const result = await withTimeoutResult(
        controller.inspectProcess(ptyId, {
          expectedIncarnationId: incarnationId,
          scanChildProcesses: true,
          includeShellLifecycle: true
        }),
        1_000
      )
      if (!result.ok) {
        return unknown('timeout')
      }
      if (
        controller !== this.ptyController ||
        this.ptysById.get(ptyId) !== record ||
        record?.incarnationId !== incarnationId ||
        this.getPtyLifecycleGeneration(ptyId) !== generation
      ) {
        return unknown('incarnation-changed')
      }
      this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
      return terminalShellLifecycleObservation(
        summary,
        this.getRuntimeId(),
        result.value,
        'old-host',
        performance.now() - started
      )
    } catch (error) {
      const reason = classifyTerminalProcessInspectionFailure(error)
      if (reason) {
        return unknown(reason)
      }
      throw error
    }
  }
}
