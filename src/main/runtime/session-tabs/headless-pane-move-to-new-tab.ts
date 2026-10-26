import type { RuntimeHeadlessTabGroups as HeadlessTabGroupsMethods } from './headless-tab-group-moves'
import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './headless-terminal-tab-close'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../pty-recorded-surface-topology'
import { withSelectedTabs } from '../headless-tab-group-selection'
import type { RuntimeMobileSessionTabGroup } from '../../../shared/runtime-session-contracts'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../../shared/terminal-tab-id'
import {
  isTerminalLeafMoveRequest,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'

/** Where the client dropped the new tab, in the host's group ids. */
export type MovedPanePlacement = { targetGroupId: string; index?: number }

export abstract class OrcaRuntimeWithHeadlessPaneMoveToNewTab extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  protected abstract persistHeadlessTabGroups(
    ...args: Parameters<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>
  ): ReturnType<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>

  // Why: a client's pane-to-new-tab move must reach the host session or the next snapshot rebuilds
  // the old tab. A window-owned host keeps its layout in the renderer, so only headless hosts commit.
  async moveMobileSessionLeafToNewTab(
    worktreeSelector: string,
    args: { sourceTabId: string; targetTabId: string; leafId: string },
    commit: (move: TerminalLeafMoveRequest) => Promise<TerminalLeafMoveResult>,
    placement?: MovedPanePlacement
  ): Promise<TerminalLeafMoveResult> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    if (this.getAvailableAuthoritativeWindow()) {
      return { status: 'not_held' }
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    // Why: the client's pty id mirrors a host handle, so the host names its own live pty; an SSH
    // respawn can leave an old id in one session copy. Headless cleanup can't retire an emptied source.
    const sourcePaneKey = makePaneKey(args.sourceTabId, args.leafId)
    let livePtyId: string | null = null
    for (const pty of this.ptysById.values()) {
      if (pty.connected && this.paneOfPty(pty).paneKey === sourcePaneKey) {
        livePtyId = pty.ptyId
      }
    }
    const move = { ...args, worktreeId, ptyId: livePtyId, keepsSourcePane: true as const }
    if (!isValidHostTerminalTabId(move.targetTabId) || !isTerminalLeafMoveRequest(move)) {
      return { status: 'refused', reason: 'invalid_request' }
    }
    const result = await commit(move)
    if (result.status === 'moved') {
      // The order the user sees now, with any reorder made meanwhile; the rebuild below puts
      // terminals ahead of editors and pages.
      const groupsBefore = this.mobileSessionTabsByWorktree.get(worktreeId)?.tabGroups ?? []
      // The live PTY follows its pane, or tab-scoped reads and actions still find it in the source.
      const pty = result.ptyId ? this.ptysById.get(result.ptyId) : undefined
      if (pty) {
        recordPtySurface(
          pty,
          move.targetTabId,
          makePaneKey(move.targetTabId, move.leafId),
          spawnSurfaceClaimSequence(this.graphSequence)
        )
      }
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
      this.placeMovedPaneTab(worktreeId, move, groupsBefore, placement)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
    return result
  }

  /**
   * Puts the committed tab where the client dropped it, selected. The groups hold the tabs the host
   * holds now, ordered as the user had them before the commit (a rebuild puts terminals first); a tab
   * opened meanwhile goes after them. Without a drop position the tab goes last in its source's group.
   */
  private placeMovedPaneTab(
    worktreeId: string,
    move: { sourceTabId: string; targetTabId: string },
    groupsBefore: readonly RuntimeMobileSessionTabGroup[],
    placement: MovedPanePlacement | undefined
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    // Why: a rebuild names a lone group with the default id; it is still the group the user had.
    const keepsLoneGroup = snapshot?.tabGroups?.length === 1 && groupsBefore.length === 1
    const rebuilt =
      keepsLoneGroup && snapshot?.tabGroups?.[0]
        ? [{ ...snapshot.tabGroups[0], id: groupsBefore[0]!.id }]
        : (snapshot?.tabGroups ?? [])
    const tabId = move.targetTabId
    const target =
      rebuilt.find((group) => group.id === placement?.targetGroupId) ??
      rebuilt.find((group) => group.tabOrder.includes(move.sourceTabId)) ??
      rebuilt.find((group) => group.tabOrder.includes(tabId))
    if (!snapshot || !target) {
      return
    }
    const ordered = rebuilt.map((group) => {
      const before = groupsBefore.find((candidate) => candidate.id === group.id)?.tabOrder ?? []
      const rank = (id: string): number => {
        const at = before.indexOf(id)
        return at === -1 ? before.length : at
      }
      return {
        id: group.id,
        tabOrder: group.tabOrder.filter((id) => id !== tabId).toSorted((a, b) => rank(a) - rank(b))
      }
    })
    const index = target.id === placement?.targetGroupId ? placement.index : undefined
    const groups = withSelectedTabs(
      groupsBefore,
      ordered.map((group) => {
        if (group.id !== target.id) {
          return group
        }
        const tabOrder = [...group.tabOrder]
        tabOrder.splice(Math.max(0, Math.min(index ?? tabOrder.length, tabOrder.length)), 0, tabId)
        return { id: group.id, tabOrder }
      }),
      tabId
    )
    const layout =
      keepsLoneGroup || !snapshot.tabGroupLayout
        ? { type: 'leaf' as const, groupId: target.id }
        : snapshot.tabGroupLayout
    const surface = snapshot.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === tabId
    )
    this.persistHeadlessTabGroups(worktreeId, groups, layout)
    this.storeMobileSessionSnapshot(worktreeId, {
      ...snapshot,
      activeGroupId: target.id,
      ...(surface
        ? {
            activeTabId: surface.id,
            activeTabType: surface.type,
            tabs: snapshot.tabs.map((tab) => ({ ...tab, isActive: tab.id === surface.id }))
          }
        : {}),
      tabGroups: groups,
      tabGroupLayout: layout
    })
  }
}
