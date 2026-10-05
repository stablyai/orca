// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseStructuredAgentSessionTab } from './orca-runtime-close-structured-agent-session-tab'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { buildHeadlessMobileSessionTabGroups } from './mobile-session-layout-projection'
import { appendRetiredTerminalSurfaceProofs } from './mobile-session-terminal-retirement-proof'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type {
  RuntimeSessionTabChatViewWrite,
  RuntimeSessionTabCloseReason,
  RuntimeSessionTabPropsResult
} from '../../shared/runtime-session-contracts'
import {
  readHeadlessChatPairState,
  resolvePaneLayoutChatOwnerFillIn,
  resolveSessionTabChatPairTarget
} from './session-tab-chat-pair'
import { terminalLayoutNodeContainsLeaf } from '../../shared/native-chat-leaf-ownership'

export class OrcaRuntimeWithCloseHeadlessMobileTerminalTab extends OrcaRuntimeWithCloseStructuredAgentSessionTab {
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
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
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
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: when a renderer is authoritative (desktop host reached via shared
    // control), it owns pane geometry and republishes it — a headless write here
    // would be overwritten and could fight the renderer. Persist only headlessly.
    if (this.getAvailableAuthoritativeWindow()) {
      return { updated: true }
    }
    // Why: resolve to the host tab id (older/raw-id clients) so the persisted
    // layout entry matches, matching setMobileSessionTabProps.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    const priorPair = readHeadlessChatPairState(
      this.getWorkspaceSessionForWorktree(worktreeId),
      snapshot,
      worktreeId,
      hostTabId
    )
    const priorOwner =
      priorPair?.pair.viewMode === 'chat' &&
      priorPair.pair.chatLeafId &&
      terminalLayoutNodeContainsLeaf(priorPair.root, priorPair.pair.chatLeafId)
        ? priorPair.pair.chatLeafId
        : null
    // Why fill-in only: stale persistence from any client must not move or clear the owner;
    // the pair writer (setTabProps) is the only lane that changes an existing owner.
    const resolvedArgs = {
      ...args,
      tabId: hostTabId,
      chatLeafId: resolvePaneLayoutChatOwnerFillIn(priorPair, args.root, args.chatLeafId)
    }
    const acceptedLayout = this.persistHeadlessTerminalPaneLayout(worktreeId, resolvedArgs)
    if (acceptedLayout) {
      // Why prior owner: persistence normalization strips an owner outside the tree before read-back.
      const ownerRetired =
        priorOwner !== null &&
        ![priorOwner, acceptedLayout.chatLeafId].some(
          (leafId) => leafId && terminalLayoutNodeContainsLeaf(acceptedLayout.root, leafId)
        )
      if (ownerRetired) {
        // Why before the layout frame: no publication may show chat without its owning pane.
        this.applyHeadlessChatPairWrite(worktreeId, hostTabId, null, 'terminal', {})
      }
      this.applyHeadlessTerminalPaneLayoutToSnapshot(worktreeId, {
        tabId: hostTabId,
        root: acceptedLayout.root,
        expandedLeafId: acceptedLayout.expandedLeafId,
        chatLeafId: ownerRetired ? null : (acceptedLayout.chatLeafId ?? null),
        ...(acceptedLayout.titlesByLeafId ? { titlesByLeafId: acceptedLayout.titlesByLeafId } : {})
      })
    }
    return { updated: true }
  }

  // Why: tab color/pin/view are host-authoritative for remote-server tabs but had no
  // push path, so they reverted on the next snapshot and were never persisted.
  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      chatViewWrite?: RuntimeSessionTabChatViewWrite
    }
  ): Promise<RuntimeSessionTabPropsResult> {
    const explicitWorktreeId = this.getValidatedExplicitWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why no await from here to the write: requests run concurrently, so the fence decision
    // and the write (or the relay send) must happen in one synchronous step.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    const authoritativeWindow = this.getAvailableAuthoritativeWindow()
    if (args.viewMode === undefined) {
      // Why: a renderer-authoritative host owns + republishes color/pin.
      if (!authoritativeWindow) {
        this.persistHeadlessSessionTabProps(worktreeId, hostTabId, args)
        this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, hostTabId, args)
      }
      return { updated: true }
    }
    const target = resolveSessionTabChatPairTarget(snapshot, args.tabId, hostTabId)
    if (authoritativeWindow) {
      // Why: today's paired clients mirror their own view, auto-exits included; a desktop host
      // takes view writes only from clients that use the fenced pair writer.
      if (!args.chatViewWrite) {
        return { updated: true }
      }
      return this.relayChatPairWrite(
        worktreeId,
        snapshot,
        target,
        args.viewMode,
        args.chatViewWrite
      )
    }
    if (args.chatViewWrite) {
      const refused = this.admitChatViewWrite(worktreeId, target.parentTabId, args.chatViewWrite)
      if (refused) {
        return refused
      }
    }
    this.applyHeadlessChatPairWrite(worktreeId, target.parentTabId, target.leafId, args.viewMode, {
      ...(args.color !== undefined ? { color: args.color } : {}),
      ...(args.isPinned !== undefined ? { isPinned: args.isPinned } : {})
    })
    if (args.chatViewWrite) {
      const { writerId, seq } = args.chatViewWrite
      this.chatViewWriteFence.confirm(worktreeId, target.parentTabId, writerId, seq)
    }
    return {
      updated: true,
      chatView: this.readMobileSessionTabChatView(worktreeId, target.parentTabId)
    }
  }
}
