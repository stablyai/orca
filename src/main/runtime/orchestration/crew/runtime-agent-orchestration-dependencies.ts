import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { captureOrchestrationTerminalCandidates } from './orchestration-terminal-candidates'
import {
  mintAgentStatusFleetEvidence,
  type ObservedAgentStatusPaneIdentity
} from '../../../ipc/agent-status-ipc-boundary'
import { readAgentOrchestrationProjectionRecords } from '../addressing/orchestration-fleet-agent-status-snapshot'
import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import { OrcaRuntimeWithRuntimeId } from '../../construction/runtime-identity-state'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'

export abstract class OrcaRuntimeWithAgentOrchestrationDependencies extends OrcaRuntimeWithRuntimeId {
  abstract retrySleptMailboxWakes(): void
  protected abstract mailWakeShellOccupied(ptyId: string): boolean
  protected abstract requestSleptMailboxWake(
    mailbox: string,
    reservedTypes?: ReadonlySet<string>
  ): void
  abstract getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined
  abstract getAgentStatusOrchestrationContextForPaneKey(
    paneKey: string
  ): AgentStatusOrchestrationContext | undefined
  abstract readonly readObservedAgentStatusPaneIdentityFn: (
    paneKey: string
  ) => ObservedAgentStatusPaneIdentity

  protected agentOrchestrationDependencies(bound?: Partial<RuntimeAgentOrchestrationDependencies>) {
    return {
      captureTerminalCandidates: () =>
        captureOrchestrationTerminalCandidates({
          leaves: this.leaves,
          ptys: this.ptysById,
          leafKey: (tab, leaf) => this.getLeafKey(tab, leaf),
          leavesForId: (id) => this.terminalIdentity.paneCandidates.leavesForId(id),
          capturePaneOf: () => this.captureTerminalPaneReader(),
          ...(!ORCA_LAYOUT_OWNER_IS_MAIN
            ? {
                ptysForPane: (pane: string) =>
                  this.terminalIdentity.paneCandidates.ptysForPane(pane),
                paneOf: (pty: Parameters<typeof this.paneOfPty>[0]) => this.paneOfPty(pty)
              }
            : {}),
          makePaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
          issueLeaf: (leaf) => this.issueHandle(leaf),
          issuePty: (pty) => this.issuePtyHandle(pty)
        }),
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
        (this.publicPaneStatusFn?.(paneKey) ?? []).map((entry) =>
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
