import { OrcaRuntimeWithPreparePtyExecutionContext } from '../launch/terminal-execution-context'

export abstract class RuntimeTerminalOutputTrackers extends OrcaRuntimeWithPreparePtyExecutionContext {
  /** Arrival-order modes include both live output and in-flight snapshot capture. */
  protected scanProviderModeTrackers(ptyId: string, data: string): void {
    this.providerModeTrackersByPtyId.get(ptyId)?.scan(data)
    for (const tracker of this.providerModeSnapshotScansByPtyId.get(ptyId) ?? []) {
      tracker.scan(data)
    }
  }
}
