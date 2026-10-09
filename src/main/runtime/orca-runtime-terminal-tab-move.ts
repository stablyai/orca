// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import {
  assertWorkspaceSessionTerminalTabMoveConsistent,
  partitionMovedTerminalTabHostSessions
} from '../../shared/workspace-session-terminal-tab-move'
import { assertValidTerminalMoveDestination } from '../../shared/terminal-move-destination'
import { rebindRuntimeTabWorktreeMaps } from './terminal-tab-worktree-rebind'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { advanceTerminalTopologyRevision } from '../persistence/terminal-topology/terminal-topology-membership'
import type { RuntimeTerminalMove } from '../../shared/runtime-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'

export class OrcaRuntimeWithTerminalTabMove extends OrcaRuntimeWithMigrationCatalog {
  async moveTerminalToWorktree(
    handle: string,
    destSelector: string,
    opts: { tab?: boolean } = {}
  ): Promise<RuntimeTerminalMove> {
    const dest = await this.resolveTerminalWorkspaceLaunchScope(destSelector)
    const binding = this.resolveTerminalMoveBinding(handle)
    assertValidTerminalMoveDestination(binding.sourceWorktreeId, dest.id)
    this.assertTerminalMoveTabOption(opts, binding)
    const sourceSession = this.getWorkspaceSessionForWorktree(binding.sourceWorktreeId)
    if (sourceSession) {
      assertWorkspaceSessionTerminalTabMoveConsistent(
        sourceSession,
        binding.sourceWorktreeId,
        binding.tabId
      )
    }
    this.assertPtyWorktreesRebound(binding.ptyIds, dest.id)
    const persisted = this.persistMovedTerminalTab(
      binding.sourceWorktreeId,
      dest.id,
      binding.tabId
    )
    if (persisted) {
      await this.flushWorkspaceSessionOrThrowAsync()
    }
    this.rebindTerminalTabWorktree(binding.tabId, dest.id)
    this.moveMobileSessionTerminalTab(binding.sourceWorktreeId, dest.id, binding.tabId)
    if (this.notifier?.moveTerminalToWorktree) {
      try {
        await this.notifier.moveTerminalToWorktree(binding.tabId, dest.id)
        this.rebindTerminalTabWorktree(binding.tabId, dest.id)
      } catch (error) {
        console.error('[runtime] failed to notify renderer of terminal move:', error)
      }
    }
    return {
      handle,
      tabId: binding.tabId,
      sourceWorktreeId: binding.sourceWorktreeId,
      destWorktreeId: dest.id,
      ptyIds: binding.ptyIds
    }
  }

  private resolveTerminalMoveBinding(handle: string): {
    tabId: string
    sourceWorktreeId: string
    ptyIds: string[]
  } {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const tabId = pty.pty.tabId
      if (!tabId) {
        throw new Error('tab_not_found')
      }
      return {
        tabId,
        sourceWorktreeId: pty.pty.worktreeId,
        ptyIds: this.collectPtyIdsForTab(pty.pty.worktreeId, tabId)
      }
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    return {
      tabId: leaf.tabId,
      sourceWorktreeId: leaf.worktreeId,
      ptyIds: this.collectPtyIdsForTab(leaf.worktreeId, leaf.tabId)
    }
  }

  private collectPtyIdsForTab(worktreeId: string, tabId: string): string[] {
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === tabId && leaf.ptyId) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      // Why: no `connected` gate — rebindRuntimeTabWorktreeMaps moves disconnected
      // records too, and the result's ptyIds must name every rebound PTY.
      if (pty.worktreeId === worktreeId && pty.tabId === tabId && pty.ptyId) {
        ptyIds.add(pty.ptyId)
      }
    }
    return [...ptyIds]
  }

  private assertTerminalMoveTabOption(
    opts: { tab?: boolean },
    binding: { tabId: string; ptyIds: string[] }
  ): void {
    if (opts.tab === true) {
      return
    }
    // Why: pane-only rehome is not implemented; a split tab without --tab
    // would silently move sibling panes too.
    let paneCount = 0
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === binding.tabId) {
        paneCount += 1
      }
    }
    if (Math.max(paneCount, binding.ptyIds.length) > 1) {
      throw new Error('terminal_move_requires_tab')
    }
  }

  private assertPtyWorktreesRebound(ptyIds: string[], destWorktreeId: string): void {
    for (const ptyId of ptyIds) {
      const remote =
        this.isSshOwnedPtyId(ptyId) || this.ptysById.get(ptyId)?.connectionId != null
      const rebound = this.ptyController?.setWorktreeId?.(ptyId, destWorktreeId) === true
      if (remote && !rebound) {
        throw new Error('pty_worktree_rebind_failed')
      }
    }
  }

  private rebindTerminalTabWorktree(tabId: string, destWorktreeId: string): void {
    rebindRuntimeTabWorktreeMaps({
      tabId,
      destWorktreeId,
      tabs: this.tabs,
      leaves: this.leaves,
      ptys: this.ptysById.values(),
      recordPtyWorktree: (ptyId, worktreeId) => {
        const leaf = [...this.leaves.values()].find(
          (candidate) => candidate.tabId === tabId && candidate.ptyId === ptyId
        )
        this.recordPtyWorktree(ptyId, worktreeId, {
          tabId,
          ...(leaf ? { paneKey: this.makeRuntimePaneKey(leaf) } : {})
        })
      }
    })
  }

  private persistMovedTerminalTab(
    sourceWorktreeId: string,
    destWorktreeId: string,
    tabId: string
  ): boolean {
    const sourceSession = this.getWorkspaceSessionForWorktree(sourceWorktreeId)
    if (!sourceSession || !this.store?.setWorkspaceSession) {
      return false
    }
    const destHostId = this.getWorkspaceSessionHostIdForWorktree(destWorktreeId)
    const sourceHostId = this.getWorkspaceSessionHostIdForWorktree(sourceWorktreeId)
    const sameHost = destHostId === sourceHostId
    const destSession = sameHost
      ? sourceSession
      : (this.getWorkspaceSessionForWorktree(destWorktreeId) ?? getDefaultWorkspaceSession())
    const partitioned = partitionMovedTerminalTabHostSessions({
      sourceSession,
      destSession,
      sourceWorktreeId,
      destWorktreeId,
      tabId,
      sameHost
    })
    if (!partitioned) {
      return false
    }
    this.setWorkspaceSessionForWorktree(
      destWorktreeId,
      advanceTerminalTopologyRevision(partitioned.dest, destWorktreeId)
    )
    if (!sameHost) {
      this.setWorkspaceSessionForWorktree(
        sourceWorktreeId,
        advanceTerminalTopologyRevision(partitioned.source, sourceWorktreeId)
      )
    }
    return true
  }

  private moveMobileSessionTerminalTab(
    sourceWorktreeId: string,
    destWorktreeId: string,
    tabId: string
  ): void {
    const sourceSnapshot = this.mobileSessionTabsByWorktree.get(sourceWorktreeId)
    if (!sourceSnapshot) {
      return
    }
    const moving = sourceSnapshot.tabs.filter(
      (tab) =>
        (tab.type === 'terminal' && (tab.parentTabId === tabId || tab.id === tabId)) ||
        tab.id === tabId
    )
    if (moving.length === 0) {
      return
    }
    const movingIds = new Set(moving.map((tab) => tab.id))
    const remaining = sourceSnapshot.tabs.filter((tab) => !movingIds.has(tab.id))
    const nextSourceActiveTabId =
      sourceSnapshot.activeTabId && movingIds.has(sourceSnapshot.activeTabId)
        ? (remaining[0]?.id ?? null)
        : sourceSnapshot.activeTabId
    const nextSourceActiveTab =
      remaining.find((tab) => tab.id === nextSourceActiveTabId) ?? remaining[0] ?? null
    const nextSource: RuntimeMobileSessionTabsSnapshot = {
      ...sourceSnapshot,
      publicationEpoch: `move:${Date.now().toString(36)}`,
      snapshotVersion: sourceSnapshot.snapshotVersion + 1,
      tabs: remaining,
      activeTabId: nextSourceActiveTabId,
      tabGroups: this.buildHeadlessMobileSessionTabGroups(
        sourceWorktreeId,
        remaining,
        nextSourceActiveTab,
        sourceSnapshot.tabGroups
      )
    }
    this.mobileSessionTabsByWorktree.set(sourceWorktreeId, nextSource)
    this.emitMobileSessionTabsSnapshot(nextSource)

    const destSnapshot = this.mobileSessionTabsByWorktree.get(destWorktreeId)
    const destTabs = [...(destSnapshot?.tabs ?? []).filter((tab) => !movingIds.has(tab.id)), ...moving]
    const movedParent =
      destTabs.find(
        (tab) => tab.id === tabId || (tab.type === 'terminal' && tab.parentTabId === tabId)
      ) ?? null
    const destGroups = this.buildHeadlessMobileSessionTabGroups(
      destWorktreeId,
      destTabs,
      movedParent,
      destSnapshot?.tabGroups
    )
    const nextDest: RuntimeMobileSessionTabsSnapshot = destSnapshot
      ? {
          ...destSnapshot,
          publicationEpoch: `move:${Date.now().toString(36)}`,
          snapshotVersion: destSnapshot.snapshotVersion + 1,
          tabs: destTabs,
          activeTabId: destSnapshot.activeTabId ?? destTabs[0]?.id ?? null,
          activeGroupId: destSnapshot.activeGroupId ?? destGroups[0]?.id ?? null,
          tabGroups: destGroups
        }
      : {
          worktree: destWorktreeId,
          publicationEpoch: `move:${Date.now().toString(36)}`,
          snapshotVersion: 1,
          activeGroupId: destGroups[0]?.id ?? null,
          activeTabId: destTabs[0]?.id ?? null,
          activeTabType: 'terminal',
          tabs: destTabs,
          tabGroups: destGroups
        }
    this.mobileSessionTabsByWorktree.set(destWorktreeId, nextDest)
    this.emitMobileSessionTabsSnapshot(nextDest)
  }
}
