import { resolveTerminalSessionWorktreeId } from '../catalog/runtime-worktree-path-identity'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { RuntimeArtifactOperations } from '../../artifacts/runtime-artifact-operations'

export abstract class OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity extends RuntimeArtifactOperations {
  protected abstract getOwnWorkspaceSessionForWorktree(
    worktreeId: string
  ): WorkspaceSessionState | null

  /** The host's saved session, when it still lists `tabId` under this worktree. */
  protected getPersistedSessionListingTerminalTab(
    worktreeId: string,
    tabId: string,
    session = this.getWorkspaceSessionForWorktree(worktreeId)
  ): WorkspaceSessionState | null {
    const sessionWorktreeId = session ? resolveTerminalSessionWorktreeId(session, worktreeId) : null
    return session &&
      sessionWorktreeId &&
      session.tabsByWorktree[sessionWorktreeId]?.some((candidate) => candidate.id === tabId)
      ? session
      : null
  }

  protected hasPersistedTerminalSurfaceMembership(
    worktreeId: string,
    tabId: string,
    leafId: string
  ): boolean {
    // Emptying a rotated partition reroutes reads to an older copy that may still list the retired surface.
    const layout = this.getPersistedSessionListingTerminalTab(
      worktreeId,
      tabId,
      this.getOwnWorkspaceSessionForWorktree(worktreeId)
    )?.terminalLayoutsByTabId[tabId]
    return Boolean(layout && layoutContainsLeafId(layout.root, leafId))
  }

  protected hasExactPersistedTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }): boolean {
    const session = this.getPersistedSessionListingTerminalTab(expected.worktreeId, expected.tabId)
    const paneKey = makePaneKey(expected.tabId, expected.leafId)
    return Boolean(
      session &&
      session.terminalLayoutsByTabId[expected.tabId]?.ptyIdsByLeafId?.[expected.leafId] ===
        expected.ptyId &&
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] === expected.incarnationId
    )
  }

  protected hasExactTerminalSurfaceIdentity(expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    terminalHandle: string
    incarnationId: string
  }): boolean {
    if (this.graphStatus !== 'ready') {
      return false
    }
    const pty = this.ptysById.get(expected.ptyId)
    if (
      !pty?.connected ||
      pty.incarnationId !== expected.incarnationId ||
      this.paneOfPty(pty).tabId !== expected.tabId ||
      this.paneOfPty(pty).paneKey !== makePaneKey(expected.tabId, expected.leafId) ||
      !worktreeIdsEqual(pty.worktreeId, expected.worktreeId) ||
      this.handleByPtyId.get(expected.ptyId) !== expected.terminalHandle
    ) {
      return false
    }
    const tab = this.tabs.get(expected.tabId)
    const leaf = this.leaves.get(this.getLeafKey(expected.tabId, expected.leafId))
    const ptyLeaves = this.getLeavesForPty(expected.ptyId)
    return (
      Boolean(tab && worktreeIdsEqual(tab.worktreeId, expected.worktreeId)) &&
      Boolean(
        leaf &&
        leaf.ptyId === expected.ptyId &&
        worktreeIdsEqual(leaf.worktreeId, expected.worktreeId)
      ) &&
      ptyLeaves.length === 1 &&
      ptyLeaves[0]?.tabId === expected.tabId &&
      ptyLeaves[0]?.leafId === expected.leafId
    )
  }
}
