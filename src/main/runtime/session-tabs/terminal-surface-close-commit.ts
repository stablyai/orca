import type { RuntimeMobileSessionTerminalTab } from '../../../shared/runtime-types'
import {
  isRetainedTerminalSurfaceIdentity,
  type TerminalSurfaceCloseIdentity
} from '../../../shared/terminal-tab-close'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand, LayoutCommandRunOptions } from '../runtime-layout-apply'
import { OrcaRuntimeWithPersistTerminalSurfaceRetirements } from './terminal-surface-retirements'
import { captureAcknowledgedTerminalTabRetirement } from '../workspace-session-terminal-tab-retirement-identity'
import { closeLeafOrTab } from '../../persistence/terminal-topology/terminal-topology-commit'
import {
  resolveTerminalCloseTarget,
  type PaneCloseResolution,
  captureTerminalCloseRequest,
  type TerminalSurfaceCloseOptions
} from '../terminal-surface-close'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'

export abstract class OrcaRuntimeWithTerminalSurfaceCloseCommit extends OrcaRuntimeWithPersistTerminalSurfaceRetirements {
  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    options?: LayoutCommandRunOptions
  ): Promise<LayoutApplyReply>
  protected originalTerminalExecutionMatches(source: TerminalSurfaceCloseIdentity): boolean {
    const current = source.ptyId ? this.ptysById.get(source.ptyId) : null
    const replacing = source.ptyId ? this.pendingPtyHandleReplacementFences.get(source.ptyId) : null
    const leaf = this.leaves.get(this.getLeafKey(source.tabId, source.leafId))
    return (
      (!current || current.incarnationId === source.incarnationId) &&
      (!leaf ||
        (leaf.worktreeId === source.worktreeId && (!leaf.ptyId || leaf.ptyId === source.ptyId))) &&
      isRetainedTerminalSurfaceIdentity(source, {
        ...source,
        worktreeId: current?.worktreeId ?? source.worktreeId,
        ptyId: current?.ptyId ?? null,
        incarnationId: replacing?.incarnationId ?? current?.incarnationId ?? null
      })
    )
  }

  /** Resolves a close main started against the copy of the tab's panes its layout owner holds. */
  protected resolveTerminalCloseTarget(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget
  ): PaneCloseResolution | 'tab' {
    const graphLeafIds: string[] = []
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === target.tabId) {
        graphLeafIds.push(leaf.leafId)
      }
    }
    return resolveTerminalCloseTarget(target, {
      rendererListsTab: this.tabs.has(target.tabId),
      snapshotRows: (this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs ?? []).filter(
        (row): row is RuntimeMobileSessionTerminalTab =>
          row.type === 'terminal' && row.parentTabId === target.tabId
      ),
      graphLeafIds,
      sessionLayout:
        this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId?.[target.tabId]
    })
  }

  protected captureTerminalTabRetirement(worktreeId: string, tabId: string) {
    const originalHostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
    return captureAcknowledgedTerminalTabRetirement(worktreeId, tabId, () => {
      const resolvedHostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
      const resolvedSession = this.store?.getWorkspaceSession?.(resolvedHostId)
      // Emptying the last tab may reroute the worktree to its catalog host.
      const hostId = resolvedSession?.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)
        ? resolvedHostId
        : originalHostId
      return {
        hostId,
        session: this.store?.getWorkspaceSession?.(hostId) ?? null,
        snapshot: this.mobileSessionTabsByWorktree.get(worktreeId),
        incarnationOf: (ptyId) => this.ptysById.get(ptyId)?.incarnationId
      }
    })
  }

  /**
   * The one close transaction every explicit terminal close reaches: durably commits the membership
   * removal in the owning host's partition. Callers publish and kill afterwards.
   */
  protected async closeTerminalSurface(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget,
    options: TerminalSurfaceCloseOptions = {}
  ): Promise<string[]> {
    const store = this.store
    if (!store?.getWorkspaceSession || !store.setWorkspaceSession || !store.runDurableMutation) {
      throw new Error('workspace_session_unavailable')
    }
    // Why: a tab its layout owner already removed has no newer owner; refusing would only strand it.
    const acknowledgeTabRetirement =
      target.kind === 'tab' && !options.closedByLayoutOwner
        ? this.captureTerminalTabRetirement(worktreeId, target.tabId)
        : null
    let ptyIdsToKill: string[] = []
    let refusal: Error | undefined
    const original = options.originalPresentation
    const hostIds = () =>
      original
        ? [
            ...new Set([
              ...original.holders.map((holder) => holder.hostId),
              ...this.getWorkspaceSessionHostIdsForTab(worktreeId, target.tabId).filter((id) =>
                this.store
                  ?.getWorkspaceSession?.(id)
                  ?.tabsByWorktree[worktreeId]?.some((tab) => tab.id === target.tabId)
              )
            ])
          ]
        : this.getWorkspaceSessionHostIdsForTab(worktreeId, target.tabId)
    const fenced = acknowledgeTabRetirement !== null && !original
    try {
      refusal = await store.runDurableMutation(
        closeLeafOrTab({
          worktreeId,
          target,
          options,
          ...captureTerminalCloseRequest(
            worktreeId,
            target,
            hostIds(),
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing guard requires this getter; preserve late-bound store access.
            store as Parameters<typeof captureTerminalCloseRequest>[3],
            fenced
          ),
          ownerMatches: () =>
            original
              ? this.originalTerminalExecutionMatches(original.identity)
              : !acknowledgeTabRetirement || acknowledgeTabRetirement().matches,
          hostIds,
          getSession: (hostId) => store.getWorkspaceSession!(hostId),
          setSession: (session, hostId) => store.setWorkspaceSession!(session, hostId),
          onClosed: (closedPtyIds) => {
            ptyIdsToKill = closedPtyIds
          }
        })
      )
    } catch (error) {
      console.error('[runtime] failed to persist terminal close:', error)
      if (original) {
        throw error
      }
    }
    if (refusal) {
      throw refusal
    }
    return ptyIdsToKill
  }
}
