import type { TerminalIdentityReadContext } from '../query/terminal-identity-read-context'
import { OrcaRuntimeWithGetOrchestrationDispatchAuthority } from './terminal-orchestration-authority'
import {
  readAgentOrchestrationProjectionRecords,
  readCapturedOrchestrationFleetAgentStatusSnapshot
} from '../../orchestration/addressing/orchestration-fleet-agent-status-snapshot'

export abstract class OrcaRuntimeWithFleetAgentStatusSnapshot extends OrcaRuntimeWithGetOrchestrationDispatchAuthority {
  /** `paneKeys` mints only those panes' hook rows. */
  getOrchestrationFleetAgentStatusSnapshot(
    context?: TerminalIdentityReadContext,
    paneKeys?: ReadonlySet<string>
  ) {
    // One facts view per fleet read; per-pane raw lookups refreshed the facts source each pane.
    const dependencies = context
      ? this.agentOrchestrationDependencies({
          paneOf: (pty) => context.paneOf(pty),
          issueLeafHandle: (leaf) => this.issueHandle(leaf, context),
          issuePtyHandle: (pty) => this.issuePtyHandle(pty, context),
          getWorktreeId: (handle) => this.getTerminalWorktreeIdForHandle(handle, context),
          getHandleForPaneKey: (pane) => this.getTerminalHandleForPaneKey(pane, context),
          getPaneKey: (handle) => this.getPaneKeyForTerminalHandle(handle, context),
          getDispatchAuthority: (handle) => this.getOrchestrationDispatchAuthority(handle, context),
          getSessionRecords: () => readAgentOrchestrationProjectionRecords(context)
        })
      : this.agentOrchestrationDependencies()
    const read = this.getAgentStatusSnapshotFn
    const rows =
      paneKeys && read
        ? () => [...paneKeys].flatMap((pane) => read(pane).filter((row) => row.paneKey === pane))
        : read
    return readCapturedOrchestrationFleetAgentStatusSnapshot(
      {
        getAgentStatusSnapshotFn: rows,
        readObservedAgentStatusPaneIdentityFn: (pane) =>
          this.readObservedAgentStatusPaneIdentityFn(pane),
        getAgentStatusTerminalHandleForPaneKey: (pane) =>
          this.getTerminalHandleForPaneKey(pane, context) ?? undefined,
        getTerminalProcessIncarnation: (handle) =>
          this.getTerminalProcessIncarnation(handle, context)
      },
      dependencies
    )
  }
}
