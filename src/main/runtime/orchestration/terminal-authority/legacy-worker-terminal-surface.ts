import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import type {
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../../../shared/runtime-terminal-contracts'
import type { PtyControllerInventory } from '../../terminal/lifecycle/runtime-pty-controller-contract'
import { resolveTerminalSessionWorktreeId } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { LegacyWorkerTerminalRecoveryPlan } from './release/orchestration-legacy-worker-terminal-recovery'
import { retireTerminalSurfacesFromSnapshot } from '../../terminal/surface/mobile-session-terminal-retirement'
import type {
  LegacyWorkerRecoveryCandidate,
  TerminalWorkspaceLaunchScope
} from './structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { getLatestPtyTitle } from '../../workspaces/process-listing/runtime-worktree-status-projection'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { forgetPtySurface } from '../../terminal/surface/pty-recorded-surface-topology'
import { OrcaRuntimeWithRestoredTerminalPlacement } from '../../workspaces/persisted-surfaces/restored-terminal-placement'

export abstract class LegacyWorkerTerminalSurface extends OrcaRuntimeWithRestoredTerminalPlacement {
  protected abstract rebuildLeafPtyIndex(): void

  protected abstract getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId

  protected abstract getTerminalTopologyRevision(worktreeId: string): number

  protected abstract getPtyDisplayRecord(pty: RuntimePtyWorktreeRecord): RuntimePtyWorktreeRecord

  abstract notifyMobileSessionTabsChanged(worktreeId?: string): void

  protected abstract adoptTerminalOrphansFromInventoryUnderMutation(
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ): Promise<RuntimeTerminalOrphanAdoptionResult>

  protected rollbackLegacyWorkerTerminalSurface(
    candidate: LegacyWorkerTerminalRecoveryPlan['candidates'][number]
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(candidate.worktreeId)
    if (snapshot) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId: candidate.ptyId,
        exactSurfaces: [{ parentTabId: candidate.tabId, leafId: candidate.leafId }],
        exactOnly: true
      })
      if (retired) {
        this.storeMobileSessionSnapshot(candidate.worktreeId, retired.snapshot)
        this.notifyMobileSessionTabsChanged(candidate.worktreeId)
      }
    }

    const leafKey = this.getLeafKey(candidate.tabId, candidate.leafId)
    const leaf = this.leaves.get(leafKey)
    const pty = this.ptysById.get(candidate.ptyId)
    if (
      leaf?.ptyId === candidate.ptyId &&
      worktreeIdsEqual(leaf.worktreeId, candidate.worktreeId)
    ) {
      this.terminalIdentity.removeLeaf(leafKey)
      const surfaceHandle = this.handleByLeafKey.get(leafKey)
      this.terminalIdentity.unbindLeaf(leafKey)
      const handleRecord = surfaceHandle ? this.handles.get(surfaceHandle) : undefined
      if (
        surfaceHandle &&
        handleRecord?.tabId === candidate.tabId &&
        handleRecord.leafId === candidate.leafId &&
        handleRecord.ptyId === candidate.ptyId
      ) {
        this.terminalIdentity.removeHandle(surfaceHandle)
      }
      this.rebuildLeafPtyIndex()
      if (![...this.leaves.values()].some((entry) => entry.tabId === candidate.tabId)) {
        this.terminalIdentity.removeTab(candidate.tabId)
      }
    }
    if (pty && this.paneOfPty(pty).tabId === candidate.tabId) {
      forgetPtySurface(this.terminalIdentity, pty)
    }
    // Why: an exit this run never saw leaves the pane's restored hook row holding the conversation;
    // a newer terminal already in the pane owns that row.
    const paneTakenOver =
      (leaf?.ptyId && leaf.ptyId !== candidate.ptyId) ||
      [...this.ptysById.values()].some(
        (other) =>
          other.ptyId !== candidate.ptyId && this.paneOfPty(other).paneKey === candidate.paneKey
      )
    if (!paneTakenOver) {
      this.reconcileAgentStatusForEndedProcessFn?.([candidate.paneKey])
    }
    this.notifier?.resolveLegacyWorkerTerminalRecovery?.(
      candidate.paneKey,
      'rolled_back',
      candidate.ptyId
    )
  }

  protected getLegacyWorkerRecoveryActivation(worktreeId: string): {
    activeTabId?: string
    activeGroupId?: string
  } {
    const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    const session =
      this.store?.getWorkspaceSession?.(hostId) ??
      this.borrowWorkspaceSessionForWorktree(worktreeId)
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    return {
      ...(sessionWorktreeId && session?.activeTabIdByWorktree?.[sessionWorktreeId]
        ? { activeTabId: session.activeTabIdByWorktree[sessionWorktreeId] }
        : {}),
      ...(sessionWorktreeId && session?.activeGroupIdByWorktree?.[sessionWorktreeId]
        ? { activeGroupId: session.activeGroupIdByWorktree[sessionWorktreeId] }
        : {})
    }
  }

  protected async adoptLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory,
    activation: { activeTabId?: string; activeGroupId?: string }
  ): Promise<void> {
    await this.adoptTerminalOrphansFromInventoryUnderMutation(
      {
        worktree: `id:${candidate.worktreeId}`,
        expectedTopologyRevision: this.getTerminalTopologyRevision(candidate.worktreeId),
        ...activation,
        claims: [
          {
            terminal: candidate.terminalHandle,
            ptyId: candidate.ptyId,
            incarnationId: candidate.incarnationId,
            tabId: candidate.tabId,
            leafId: candidate.leafId
          }
        ]
      },
      workspace,
      inventory
    )
  }

  protected async revealLegacyWorkerTerminal(
    candidate: LegacyWorkerRecoveryCandidate
  ): Promise<boolean | null> {
    const pty = this.ptysById.get(candidate.ptyId)
    if (!pty || !this.notifier?.revealTerminalSession) {
      return null
    }
    const reveal = await this.notifier.revealTerminalSession(candidate.worktreeId, {
      ptyId: candidate.ptyId,
      title: getLatestPtyTitle(this.getPtyDisplayRecord(pty)) ?? pty.controllerTitle,
      activate: false,
      presentation: 'background',
      tabId: candidate.tabId,
      leafId: candidate.leafId,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: candidate.terminalHandle,
        incarnationId: candidate.incarnationId
      }
    })
    const identity = reveal?.identity
    return Boolean(
      identity &&
      worktreeIdsEqual(identity.worktreeId, candidate.worktreeId) &&
      identity.tabId === candidate.tabId &&
      identity.leafId === candidate.leafId &&
      identity.ptyId === candidate.ptyId
    )
  }
}
