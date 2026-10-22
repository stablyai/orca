import type { RuntimeHeadlessTabProperties as HeadlessTabPropertiesMethods } from './headless-tab-properties'
import type { RuntimeHeadlessTabGroups as HeadlessTabGroupsMethods } from './headless-tab-group-moves'
import type { OrcaRuntimeWithPersistHeadlessTerminalTitle as PersistHeadlessTerminalTitleMethods } from '../workspaces/workspace-file-session-targets'
import { OrcaRuntimeWithMainLayoutTabMoves } from './main-layout-session-tab-move'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { buildHeadlessMobileSessionTabGroups } from '../mobile-session-layout-projection'
import { paneTitlesForDesktopWindow } from './desktop-pane-title-forwarding'
import { appendRetiredTerminalSurfaceProofs } from '../../../shared/terminal-retirement-proof-ledger'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { RuntimeTerminalRename } from '../../../shared/runtime-terminal-contracts'
import type { RuntimeSessionTabCloseReason } from '../../../shared/runtime-session-contracts'

export abstract class OrcaRuntimeWithCloseHeadlessMobileTerminalTab extends OrcaRuntimeWithMainLayoutTabMoves {
  protected abstract applyHeadlessSessionTabPropsToSnapshot(
    ...args: Parameters<HeadlessTabPropertiesMethods['applyHeadlessSessionTabPropsToSnapshot']>
  ): ReturnType<HeadlessTabPropertiesMethods['applyHeadlessSessionTabPropsToSnapshot']>

  protected abstract applyHeadlessTerminalPaneLayoutToSnapshot(
    ...args: Parameters<HeadlessTabPropertiesMethods['applyHeadlessTerminalPaneLayoutToSnapshot']>
  ): ReturnType<HeadlessTabPropertiesMethods['applyHeadlessTerminalPaneLayoutToSnapshot']>

  protected abstract moveHeadlessMobileSessionTab(
    ...args: Parameters<HeadlessTabGroupsMethods['moveHeadlessMobileSessionTab']>
  ): ReturnType<HeadlessTabGroupsMethods['moveHeadlessMobileSessionTab']>

  protected abstract normalizeMobileSessionTabOrder(
    ...args: Parameters<PersistHeadlessTerminalTitleMethods['normalizeMobileSessionTabOrder']>
  ): ReturnType<PersistHeadlessTerminalTitleMethods['normalizeMobileSessionTabOrder']>

  protected abstract persistHeadlessSessionTabProps(
    ...args: Parameters<HeadlessTabPropertiesMethods['persistHeadlessSessionTabProps']>
  ): ReturnType<HeadlessTabPropertiesMethods['persistHeadlessSessionTabProps']>

  protected abstract persistHeadlessTerminalPaneLayout(
    ...args: Parameters<HeadlessTabPropertiesMethods['persistHeadlessTerminalPaneLayout']>
  ): ReturnType<HeadlessTabPropertiesMethods['persistHeadlessTerminalPaneLayout']>

  protected abstract getPtyIdsForExplicitTabClose(worktreeId: string, tabId: string): string[]

  abstract renameTerminal(handle: string, title: string | null): Promise<RuntimeTerminalRename>

  protected async closeHeadlessMobileTerminalTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionTerminalTab,
    options: {
      allowMissingPersistedTab?: boolean
      killPtys?: boolean
      authorizedPty?: RuntimePtyWorktreeRecord
      force?: boolean
      reason?: RuntimeSessionTabCloseReason
    } = {}
  ): Promise<void> {
    const closedParentTabId = tab.parentTabId
    const retirementProofs = snapshot.tabs.flatMap((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return []
      }
      const proof = this.getMobileSessionTerminalRetirementProof(
        worktreeId,
        candidate,
        options.authorizedPty
      )
      return proof ? [proof] : []
    })
    const acknowledgeRetirement = this.captureTerminalTabRetirement(worktreeId, closedParentTabId)
    const projectedPtyIds = await this.closeTerminalSurface(
      worktreeId,
      { kind: 'tab', tabId: closedParentTabId },
      {
        allowMissing: options.allowMissingPersistedTab,
        force: options.force,
        reason: options.reason
      }
    )
    if (!acknowledgeRetirement().matches) {
      throw new Error('terminal_pane_owner_changed')
    }
    // Renderer frames may add other tabs while the durable close is in flight.
    snapshot = this.mobileSessionTabsByWorktree.get(worktreeId) ?? snapshot
    this.clearRuntimeSessionOwnershipForMobileTab(worktreeId, snapshot, closedParentTabId)
    if (options.authorizedPty) {
      options.authorizedPty.runtimeSessionOwned = false
      this.setPairedRendererSessionOwnership(options.authorizedPty.ptyId, false)
    }
    // Why: local provider ids can be reused after restart, so a dormant
    // persisted id is not kill authority. SSH relay ids remain durable exact
    // identities even before pane metadata reconnects.
    const ptyIdsToKill = new Set(projectedPtyIds.filter((ptyId) => parseAppSshPtyId(ptyId)))
    for (const candidate of snapshot.tabs) {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        continue
      }
      const authorizedPty =
        options.authorizedPty &&
        this.getMobileTerminalLeafPtyIds(candidate).includes(options.authorizedPty.ptyId)
          ? options.authorizedPty
          : null
      const livePty = this.findPtyForMobileTerminalTab(worktreeId, candidate) ?? authorizedPty
      const ptyId = livePty?.ptyId ?? candidate.ptyId
      const hasOtherOwner = snapshot.tabs.some(
        (other) =>
          other.type === 'terminal' &&
          other.parentTabId !== closedParentTabId &&
          other.ptyId === ptyId
      )
      if (ptyId && !hasOtherOwner && (livePty || parseAppSshPtyId(ptyId))) {
        // Why: a live serve leaf can exist before its debounced binding reaches
        // persistence. Include it from the authoritative snapshot so split
        // close cannot leave a provider process behind.
        ptyIdsToKill.add(ptyId)
      }
    }
    if (options.killPtys !== false) {
      for (const ptyId of ptyIdsToKill) {
        this.ptyController?.kill(ptyId)
      }
    }
    const nextTabs = snapshot.tabs.filter((candidate) => {
      if (candidate.type !== 'terminal' || candidate.parentTabId !== closedParentTabId) {
        return true
      }
      return false
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    // A close is not a handover: the generation publishing this worktree still is. Minting an epoch
    // here published a stranger for a worktree the renderer owns, and a client that retires what it
    // displaces then rejected that renderer's own next frame. The sibling headless writers carry the
    // stored epoch forward for the same reason; `...snapshot` is what does it here.
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        nextTabs,
        active,
        snapshot.tabGroups
      ),
      ...(retirementProofs.length > 0
        ? {
            retiredTerminalSurfaces: appendRetiredTerminalSurfaceProofs(
              snapshot.retiredTerminalSurfaces,
              retirementProofs
            )
          }
        : {}),
      tabs: nextTabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
    }
    const movedInMain = await this.moveTabInMainLayout(worktreeId, snapshot, move)
    if (movedInMain) {
      return movedInMain
    }
    if (!this.notifier?.moveSessionTab) {
      return this.moveHeadlessMobileSessionTab(worktreeId, snapshot, move)
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }

    // Why: web clients address terminal surfaces as tab::leaf, while desktop
    // tab grouping is owned by the outer terminal tab id.
    if (move.kind === 'reorder') {
      const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
      if (!tabOrder.includes(hostTabId)) {
        throw new Error('invalid_tab_order')
      }
      this.notifier.moveSessionTab(worktreeId, {
        ...move,
        tabId: hostTabId,
        tabOrder
      })
      return { moved: true }
    }
    this.notifier.moveSessionTab(worktreeId, {
      ...move,
      tabId: hostTabId
    })
    return { moved: true }
  }

  // Why: pane geometry inside a tab (split ratios, expanded pane, pane titles)
  // is host-authoritative for remote-server tabs but had no push path, so a
  // client divider-drag / expand / pane-rename reverted on the next snapshot.
  // Persist the structural fields onto the tab's layout, keeping host-owned
  // pty bindings and active leaf.
  async updateMobileSessionPaneLayout(
    worktreeSelector: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      chatLeafId?: string | null
      titlesByLeafId?: Record<string, string>
      renamedLeafIds?: string[]
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: resolve to the host tab id (older/raw-id clients) so the persisted
    // layout entry matches, matching setMobileSessionTabProps.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    // Switch point: pane names in a tab main owns are main's renames, so only geometry goes on.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      args = await this.nameMainPanes(worktreeId, hostTabId, args)
    }
    // Why: when a renderer is authoritative (desktop host reached via shared
    // control), it owns pane geometry and republishes it — a headless write here
    // would be overwritten and could fight the renderer. Only pane names, which
    // the window takes one pane at a time, are passed on to it.
    if (this.getAvailableAuthoritativeWindow()) {
      // Why: only panes the client says it renamed; a resent map may predate the host's names.
      const renamed = new Set(args.renamedLeafIds)
      if (args.titlesByLeafId && renamed.size > 0 && this.notifier?.setPaneTitle) {
        const tab = this.getWorkspaceSessionForWorktree(worktreeId)?.tabsByWorktree[
          worktreeId
        ]?.find((candidate) => candidate.id === hostTabId)
        const { titlesByLeafId, root } = args
        const forwarded = paneTitlesForDesktopWindow({ root, titlesByLeafId, tab })
        for (const { leafId, title } of forwarded.filter(({ leafId }) => renamed.has(leafId))) {
          // A failed send must fail the call, so the client retries rather than dropping it.
          if (!this.notifier.setPaneTitle(hostTabId, leafId, title)) {
            throw new Error('runtime_unavailable')
          }
        }
      }
      return { updated: true }
    }
    const resolvedArgs = { ...args, tabId: hostTabId }
    const acceptedLayout = this.persistHeadlessTerminalPaneLayout(worktreeId, resolvedArgs)
    if (acceptedLayout) {
      this.applyHeadlessTerminalPaneLayoutToSnapshot(worktreeId, {
        tabId: hostTabId,
        root: acceptedLayout.root,
        expandedLeafId: acceptedLayout.expandedLeafId,
        chatLeafId: acceptedLayout.chatLeafId ?? null,
        ...(acceptedLayout.titlesByLeafId ? { titlesByLeafId: acceptedLayout.titlesByLeafId } : {})
      })
    }
    return { updated: true }
  }

  // Why: tab color/pin are host-authoritative for remote-server tabs but had no
  // push path, so pinning or coloring a tab reverted on the next snapshot and
  // was never persisted. Persist to the workspace session + live snapshot.
  /** What `title` reads once a manual name is cleared; readers that predate `customTitle` show it. */
  protected headlessTerminalFallbackTitle(worktreeId: string, tabId: string): string {
    const tab = this.getWorkspaceSessionForWorktree(worktreeId)?.tabsByWorktree[worktreeId]?.find(
      (candidate) => candidate.id === tabId
    )
    return (
      tab?.generatedTitle?.trim() || tab?.title?.trim() || tab?.defaultTitle?.trim() || 'Terminal'
    )
  }

  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      customTitle?: string | null
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: a renderer-authoritative host owns + republishes tab props, so a
    // headless write would be overwritten. Persist only when headless.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    // Why by tab: a sleeping or starting pane has no handle for terminal.rename to name (#29975).
    const customTitle =
      args.customTitle === undefined ? undefined : args.customTitle?.trim() || null
    // Switch point: a terminal tab main owns takes its props in main's layout, window or not.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && (await this.setMainTabProps(worktreeId, hostTabId, args))) {
      return { updated: true }
    }
    if (this.getAvailableAuthoritativeWindow()) {
      if (customTitle !== undefined) {
        this.notifier?.renameTerminal(hostTabId, customTitle)
      }
      return { updated: true }
    }
    this.persistHeadlessSessionTabProps(worktreeId, hostTabId, args)
    // Why: a live pane's own title outranks the snapshot's, so name it the way terminal.rename does.
    const liveHandles =
      customTitle === undefined
        ? []
        : this.getPtyIdsForExplicitTabClose(worktreeId, hostTabId).flatMap((ptyId) => {
            const handle = this.handleByPtyId.get(ptyId)
            return handle ? [handle] : []
          })
    for (const handle of liveHandles) {
      await this.renameTerminal(handle, customTitle ?? null)
    }
    if (customTitle !== undefined && liveHandles.length === 0) {
      this.persistHeadlessTerminalTitle(worktreeId, hostTabId, customTitle)
    }
    // A live pane's rename above already set its title; only a paneless tab needs `title` here.
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, hostTabId, {
      ...args,
      ...(customTitle !== undefined && liveHandles.length === 0
        ? {
            customTitle,
            title: customTitle ?? this.headlessTerminalFallbackTitle(worktreeId, hostTabId)
          }
        : {})
    })
    return { updated: true }
  }
}
