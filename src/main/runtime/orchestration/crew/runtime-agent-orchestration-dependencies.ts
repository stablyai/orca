import { mintAgentStatusFleetEvidence } from '../../../ipc/agent-status-ipc-boundary'
import { readAgentOrchestrationProjectionRecords } from '../addressing/orchestration-fleet-agent-status-snapshot'
import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import { OrcaRuntimeWithRuntimeId } from '../../construction/runtime-identity-state'

export abstract class OrcaRuntimeWithAgentOrchestrationDependencies extends OrcaRuntimeWithRuntimeId {
  protected agentOrchestrationDependencies(bound?: Partial<RuntimeAgentOrchestrationDependencies>) {
    return {
      getDb: () => this.getOrchestrationDbIfAvailable(),
      getLeaves: () => this.leaves.values(),
      getPtys: () => this.ptysById.values(),
      paneOf: (pty) => this.paneOfPty(pty),
      issueLeafHandle: (leaf) => this.issueHandle(leaf),
      issuePtyHandle: (pty) => this.issuePtyHandle(pty),
      makePaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
      getWorktreeId: (handle) => this.getTerminalWorktreeIdForHandle(handle),
      getHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey),
      getPaneKey: (handle) => this.getPaneKeyForTerminalHandle(handle),
      getDispatchAuthority: (handle) => this.getOrchestrationDispatchAuthority(handle),
      getAgentStatusSnapshot: () => this.getOrchestrationFleetAgentStatusSnapshot(),
      getAgentStatusForPaneKey: (paneKey, contextForPane) =>
        (this.getAgentStatusSnapshotForPaneFn?.(paneKey) ?? []).map((entry) =>
          mintAgentStatusFleetEvidence(
            entry,
            {
              getAgentStatusTerminalHandleForPaneKey: (pane) =>
                this.getAgentStatusTerminalHandleForPaneKey(pane),
              getTerminalProcessIncarnation: (handle) => this.getTerminalProcessIncarnation(handle),
              getAgentStatusOrchestrationContextForPaneKey:
                contextForPane ??
                ((pane) => this.getAgentStatusOrchestrationContextForPaneKey(pane))
            },
            this.readObservedAgentStatusPaneIdentityFn(paneKey)
          )
        ),
      getSessionRecords: () => readAgentOrchestrationProjectionRecords(),
      ...bound
    } satisfies RuntimeAgentOrchestrationDependencies
  }
}
