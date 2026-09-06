// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSubscribeToTerminalResize } from './orca-runtime-subscribe-to-terminal-resize'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { resolveTerminalSessionWorktreeId } from './runtime-worktree-path-identity'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { adoptRuntimeTerminalOrphansFromInventory } from './runtime-terminal-orphan-adoption'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'

export class OrcaRuntimeWithAdoptTerminalOrphansFromInventory extends OrcaRuntimeWithSubscribeToTerminalResize {
  protected async adoptTerminalOrphansFromInventoryUnderMutation(
    request: RuntimeTerminalOrphanAdoptionRequest,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: PtyControllerInventory
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    const store = this.store
    const session = this.getWorkspaceSessionForWorktree(workspace.id)
    if (
      !store?.setWorkspaceSession ||
      (!store.flushPendingOrThrowAsync && !store.flushOrThrow) ||
      !session
    ) {
      throw new Error('workspace_session_unavailable')
    }
    const sessionWorktreeId = resolveTerminalSessionWorktreeId(session, workspace.id)
    if (!sessionWorktreeId) {
      throw new Error('terminal_orphan_competing_owner')
    }
    const worktreeConnectionId = workspace.connectionId
    let worktreeWslDistro: string | null = null
    if (!worktreeConnectionId && workspace.repo) {
      try {
        worktreeWslDistro =
          getLocalProjectWorktreeGitOptions(this.requireStore(), workspace.repo).wslDistro ?? null
      } catch {
        throw new Error('terminal_orphan_owner_mismatch')
      }
    }
    return adoptRuntimeTerminalOrphansFromInventory({
      request,
      workspace,
      inventory,
      session,
      sessionWorktreeId,
      repoId: getRepoIdFromWorktreeId(workspace.id),
      worktreeWslDistro,
      currentRevision: this.getTerminalTopologyRevision(workspace.id),
      ports: {
        getPty: (handle) => this.getLivePtyForHandle(handle)?.pty ?? null,
        getLeaves: (ptyId) => this.getLeavesForPty(ptyId),
        getLeaf: (tabId, leafId) => this.leaves.get(this.getLeafKey(tabId, leafId)),
        getMobileSnapshots: () => this.mobileSessionTabsByWorktree.values(),
        getSession: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
        setSession: (worktreeId, next) => this.setWorkspaceSessionForWorktree(worktreeId, next),
        flushSession: () => this.flushWorkspaceSessionOrThrowAsync(),
        hydrateSession: (worktreeId) =>
          this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
            force: true,
            allowAttachedWindow: true,
            onlyRuntimeOwnedTerminals: true
          }),
        notifySessionChanged: (worktreeId) => this.notifyMobileSessionTabsChanged(worktreeId),
        getSnapshot: (worktreeId) => this.getTerminalOrphanAdoptionSnapshot(worktreeId)
      }
    })
  }

  protected getTerminalOrphanAdoptionSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    return this.getMobileSessionTabsForWorktree(worktreeId)
  }

  // Why: when --terminal is omitted, the CLI auto-resolves to the active
  // terminal in the current worktree — matching browser's implicit active tab.
  async resolveActiveTerminal(worktreeSelector?: string): Promise<string> {
    if (this.graphStatus !== 'ready') {
      const targetWorktreeId = worktreeSelector
        ? (await this.resolveWorktreeSelector(worktreeSelector)).id
        : null
      const snapshots = targetWorktreeId
        ? [this.getMobileSessionTabsForWorktree(targetWorktreeId)]
        : await this.listAllMobileSessionTabs()
      for (const snapshot of snapshots) {
        const activeTerminal = snapshot.tabs.find(
          (tab) =>
            tab.type === 'terminal' &&
            tab.isActive &&
            tab.status === 'ready' &&
            typeof tab.terminal === 'string'
        )
        if (activeTerminal?.type === 'terminal' && activeTerminal.terminal) {
          return activeTerminal.terminal
        }
      }
      const listed = await this.listTerminals(worktreeSelector, undefined, {
        includeVisualLayouts: false
      })
      const first = listed.terminals[0]?.handle
      if (first) {
        return first
      }
      throw new Error('no_active_terminal')
    }
    this.assertGraphReady()

    const targetWorktreeId = worktreeSelector
      ? (await this.resolveWorktreeSelector(worktreeSelector)).id
      : null

    // Prefer the tab's activeLeafId — this is the pane the user last focused
    for (const tab of this.tabs.values()) {
      if (targetWorktreeId && tab.worktreeId !== targetWorktreeId) {
        continue
      }
      if (!tab.activeLeafId) {
        continue
      }
      const leafKey = this.getLeafKey(tab.tabId, tab.activeLeafId)
      const leaf = this.leaves.get(leafKey)
      if (leaf) {
        return this.issueHandle(leaf)
      }
    }

    // Fallback: any leaf in the target worktree
    for (const leaf of this.leaves.values()) {
      if (targetWorktreeId && leaf.worktreeId !== targetWorktreeId) {
        continue
      }
      return this.issueHandle(leaf)
    }

    throw new Error('no_active_terminal')
  }

  // Why: orchestration records the pane key as the remint-stable assignee
  // identity at dispatch time; null (best-effort) rather than throwing so
  // dispatch still works for handles without a resolvable pane.
  getTerminalPaneKey(handle: string): string | null {
    return this.getPaneKeyForTerminalHandle(handle)
  }

  getLiveTerminalPaneKey(handle: string): string | null {
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      return runtimePty.pty.connected ? (runtimePty.pty.paneKey ?? null) : null
    }
    try {
      const leaf = this.resolveLiveLeafForHandle(handle)
      if (!leaf?.ptyId) {
        return null
      }
      const pty = this.ptysById.get(leaf.ptyId)
      return pty?.connected === false ? null : this.getPaneKeyForTerminalHandle(handle)
    } catch {
      return null
    }
  }

  getTerminalLivenessVerdict(handle: string): PtyLivenessVerdict | null {
    try {
      return this.getPtyLivenessVerdict(this.getTerminalAgentStatusPtyId(handle))
    } catch {
      return null
    }
  }
}
