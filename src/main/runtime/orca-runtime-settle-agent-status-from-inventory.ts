import { OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController } from './orca-runtime-refresh-pty-worktree-records-from-controller'
import {
  settleAgentStatusRowsAbsentFromInventory,
  type AgentStatusPtyInventoryAnswer
} from './runtime-agent-status-inventory-settlement'
import {
  indexPersistedPaneKeyPtyIds,
  resolveAgentWorkspaceExecutionHostId
} from '../agent-hooks/agent-status-pane-binding'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { retireOrchestrationAuthorityAbsentFromInventory } from './runtime-restored-orchestration-authority-sweep'

export class OrcaRuntimeWithSettleAgentStatusFromInventory extends OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController {
  /**
   * Both durable obligations that retire from one completed inventory answer.
   *
   * They read the same three facts — who answered, what is live, and under whose connection scope
   * — so they are settled together rather than each re-deriving the diff.
   */
  protected retireObligationsAbsentFromInventory(answer: AgentStatusPtyInventoryAnswer): void {
    // Why: runs after the hasPty rescue so a still-addressable pane keeps its receipt.
    retireOrchestrationAuthorityAbsentFromInventory(
      this.restoredOrchestrationAuthorityByPtyId,
      answer
    )
    // Why fire-and-forget: this consumer may have to re-ask a provider about an exact id, and the
    // listing is on the terminal-list hot path. A throw here must not abort it.
    void this.settleAgentStatusRowsAbsentFromInventory(answer)
  }

  /**
   * The PTY this EXACT pane is bound to in this runtime, or undefined.
   *
   * Deliberately not `getPtyRecordForPaneKey`: that resolver falls back to a same-leaf match in
   * another tab, which is a good guess for display and a wrong answer for a fence.
   */
  protected getBoundPtyIdForPaneKey(paneKey: string): string | undefined {
    const parsed = parsePaneKey(paneKey)
    if (parsed) {
      for (const leaf of this.leaves.values()) {
        if (leaf.ptyId && leaf.tabId === parsed.tabId && leaf.leafId === parsed.leafId) {
          return leaf.ptyId
        }
      }
    }
    for (const pty of this.ptysById.values()) {
      if (pty.paneKey === paneKey) {
        return pty.ptyId
      }
    }
    return undefined
  }

  /**
   * Second consumer of this inventory's answer: retire agent-status rows whose PTY the owning
   * host proved absent. The verdict rules live in runtime-agent-status-inventory-settlement.ts.
   */
  protected async settleAgentStatusRowsAbsentFromInventory(
    answer: AgentStatusPtyInventoryAnswer
  ): Promise<number> {
    const port = this.agentStatusPtyInventorySettlementFn
    if (!port) {
      return 0
    }
    const persistedByHostId = new Map<string, ReadonlyMap<string, string>>()
    try {
      return await settleAgentStatusRowsAbsentFromInventory(answer, {
        listCandidates: () => port.listCandidates(),
        settle: (settled) => port.settle(settled),
        resolveRowExecutionHostId: (candidate) =>
          resolveAgentWorkspaceExecutionHostId(candidate.worktreeId, {
            getRepo: (repoId) => this.store?.getRepo?.(repoId),
            getWorktreeMeta: (worktreeId) => this.store?.getWorktreeMeta?.(worktreeId),
            getFolderWorkspace: (folderWorkspaceId) =>
              this.store
                ?.getFolderWorkspaces?.()
                ?.find((workspace) => workspace.id === folderWorkspaceId),
            getProjectGroups: () => this.store?.getProjectGroups?.() ?? []
          }),
        getBoundPtyIdForPaneKey: (paneKey) => this.getBoundPtyIdForPaneKey(paneKey),
        getPersistedPtyIdForPaneKey: (paneKey, hostId) => {
          let index = persistedByHostId.get(hostId)
          if (!index) {
            index = indexPersistedPaneKeyPtyIds(
              this.store?.getWorkspaceSession?.(hostId)?.terminalLayoutsByTabId ?? {}
            )
            persistedByHostId.set(hostId, index)
          }
          return index.get(paneKey)
        },
        readLivenessVerdict: (ptyId) => this.getPtyLivenessVerdict(ptyId),
        probePtyLiveness: async (ptyId) =>
          (await this.ptyController?.probePtyLiveness?.(ptyId)) ?? null
      })
    } catch (error) {
      console.warn('[agent-hooks] pty-inventory status settlement failed:', error)
      return 0
    }
  }
}
