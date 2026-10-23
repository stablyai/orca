import { selectFreshAgentRowForMobileTab } from '../../runtime-hook-agent-row-selection'
import { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from '../../session-tabs/session-tabs-change-publication'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import { mergeMobileSessionTabGroups } from '../../mobile-session-tab-merge'
import { buildHeadlessMobileSessionTabGroups } from '../../mobile-session-layout-projection'
import { projectRuntimeMobileSessionTabs } from '../../runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from '../../runtime-mobile-session-projection-contract'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { RuntimeAgentRowSnapshot } from '../../runtime-worktree-agent-rows'
import type {
  AgentStatusEntry,
  AgentStatusIpcPayload,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import { buildRuntimeMobileAgentStatus } from '../../runtime-mobile-agent-status-builder'
import { FIRST_PANE_ID } from '../../../../shared/pane-key'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerHandleAgentStatus } from '../../orchestration/structured-worker-group-addressing'
import {
  retitleStructuredConversationTab,
  titleStructuredConversationTabs
} from '../../structured-conversation-tab-title'
import { structuredChatDisplayName } from '../../../../shared/structured-chat-row-name'

export abstract class OrcaRuntimeWithPruneMobileSessionTabGroupLayout extends OrcaRuntimeWithScheduleMobileSessionTabsChanged {
  constructor(
    ...args: ConstructorParameters<typeof OrcaRuntimeWithScheduleMobileSessionTabsChanged>
  ) {
    super(...args)
    // Why: a desktop rename of a chat tab reaches main only through the window's saved session.
    this.store?.onWorkspaceSessionWritten?.(() => {
      for (const [workspaceId, snapshot] of this.mobileSessionTabsByWorktree) {
        for (const tab of snapshot.tabs) {
          if (tab.type === 'agent-session') {
            this.refreshStructuredConversationTabTitle(workspaceId, tab.sessionId)
          }
        }
      }
    })
  }

  protected pruneMobileSessionTabGroupLayout(
    layout: TabGroupLayoutNode | null | undefined,
    validGroupIds: ReadonlySet<string>
  ): TabGroupLayoutNode | null {
    if (!layout) {
      return null
    }
    if (layout.type === 'leaf') {
      return validGroupIds.has(layout.groupId) ? layout : null
    }
    const first = this.pruneMobileSessionTabGroupLayout(layout.first, validGroupIds)
    const second = this.pruneMobileSessionTabGroupLayout(layout.second, validGroupIds)
    if (first && second) {
      return { ...layout, first, second }
    }
    return first ?? second
  }

  // Instance seams over the tab-group projections so callers (and tests) can
  // reach them through the runtime the way the rest of this surface is reached.
  protected mergeMobileSessionTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    tabs: readonly RuntimeMobileSessionSnapshotTab[],
    activeTab: RuntimeMobileSessionTerminalTab | null
  ): RuntimeMobileSessionTabGroup[] {
    return mergeMobileSessionTabGroups(worktreeId, groups, tabs, activeTab)
  }

  protected buildHeadlessMobileSessionTabGroups(
    worktreeId: string,
    tabs: readonly RuntimeMobileSessionSnapshotTab[],
    activeTab: RuntimeMobileSessionSnapshotTab | null,
    existingGroups?: readonly RuntimeMobileSessionTabGroup[],
    newTabAssignment?: { tabId: string; groupId: string }
  ): RuntimeMobileSessionTabGroup[] {
    return buildHeadlessMobileSessionTabGroups(
      worktreeId,
      tabs,
      activeTab,
      existingGroups,
      newTabAssignment
    )
  }

  /** Transforms an internal mobile session tab snapshot into a sanitized client payload, resolving launch-agent ownership and normalizing titles. */
  protected toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult {
    snapshot = titleStructuredConversationTabs(snapshot, (sessionId) =>
      this.structuredConversationTabName(snapshot.worktree, sessionId)
    )
    return projectRuntimeMobileSessionTabs(snapshot, this.getMobileSessionProjectionHost())
  }

  refreshStructuredConversationTabTitle(workspaceId: string, sessionId: string): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(workspaceId)
    if (!snapshot) {
      return
    }
    const next = retitleStructuredConversationTab(
      snapshot,
      sessionId,
      this.structuredConversationTabName(workspaceId, sessionId)
    )
    if (next) {
      this.emitMobileSessionTabsSnapshot(this.storeMobileSessionSnapshot(workspaceId, next))
    }
  }

  /** The desktop tab's rename, else the chat's saved name; null leaves the agent's default label. */
  private structuredConversationTabName(workspaceId: string, sessionId: string): string | null {
    const record = getStructuredAgentSessionHost()?.deps?.store?.getRecord(sessionId)
    const customLabel = this.getWorkspaceSessionForWorktree(workspaceId)?.unifiedTabs?.[
      workspaceId
    ]?.find((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)?.customLabel
    const conversationName =
      record?.location.workspaceId === workspaceId ? record.conversationName : null
    return structuredChatDisplayName(customLabel, conversationName, '') || null
  }

  protected getMobileSessionProjectionHost(): RuntimeMobileSessionProjectionHost {
    return {
      tabs: this.tabs,
      leaves: this.leaves,
      ptysById: this.ptysById,
      getLiveBrowserTabs: (worktreeId) => this.getListedBrowserTabsByPageId(worktreeId),
      getProviderSessionRows: (paneKey) => this.getAgentProviderSessionRowsForPaneFn?.(paneKey),
      getProviderSessionSnapshot: () => this.getAgentProviderSessionSnapshotFn?.() ?? [],
      getStatusSnapshot: () => this.getAgentStatusSnapshotFn?.() ?? [],
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      findPty: (worktreeId, tab, options) =>
        this.findPtyForMobileTerminalTab(worktreeId, tab, options),
      getRetainedStatus: (paneKey, pty, tab, getRows) =>
        this.getFreshRetainedAgentStatusForMobileTab(paneKey, pty, tab, getRows),
      getTrackedTitle: (ptyId) => this.getUnpersistedTrackedTitleForPty(ptyId),
      getTitleDisplayClear: (ptyId) => this.getPtyTitleDisplayClear(ptyId),
      issuePtyHandle: (pty) => this.issuePtyHandle(pty),
      recordPty: (ptyId, worktreeId, state) => this.recordPtyWorktree(ptyId, worktreeId, state),
      buildPtyStatus: (pty, tab, terminalHandle, retained, getRows) =>
        this.buildPtyMobileAgentStatus(pty, tab, terminalHandle, retained, getRows),
      sanitizeGroups: (groups, tabs) => this.sanitizeMobileSessionTabGroups(groups, tabs),
      pruneGroupLayout: (layout, validGroupIds) =>
        this.pruneMobileSessionTabGroupLayout(layout, validGroupIds),
      collectTabIds: (tabs) => this.collectReturnedSessionTabIds(tabs)
    }
  }

  protected buildPtyMobileAgentStatus(
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab,
    terminalHandle: string | null,
    retained: RuntimeAgentRowSnapshot | null,
    getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[]
  ): { agentStatus: AgentStatusEntry } | Record<string, never> {
    // Why display records: a phone status is presentation, so it shows the stale-working clear.
    const displayPty = pty ? this.getPtyDisplayRecord(pty) : null
    return buildRuntimeMobileAgentStatus(
      displayPty,
      tab,
      terminalHandle,
      retained,
      getHookRowsForPane,
      {
        getPaneKey: (candidate) => this.getMobileTerminalPaneKey(candidate),
        getLeaf: (candidate) => {
          const leaf = this.leaves.get(this.getLeafKey(candidate.parentTabId, candidate.leafId))
          return leaf ? this.getLeafDisplayRecord(leaf) : null
        },
        getTrackedTitle: (ptyId) => this.getUnpersistedTrackedTitleForPty(ptyId),
        getPtyTitleObservedAtEpochMs: (ptyId) =>
          ptyId ? (this.ptysById.get(ptyId)?.lastOscTitleEpochMs ?? null) : null
      }
    )
  }

  protected getFreshRetainedAgentStatusForMobileTab(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    _tab: RuntimeMobileSessionTerminalTab,
    getRows: (paneKey: string, terminalHandle: string | null) => AgentStatusIpcPayload[]
  ): RuntimeAgentRowSnapshot | null {
    const paneMatch = selectFreshAgentRowForMobileTab({
      paneKey,
      terminalHandle: null,
      hookRows: getRows(paneKey, null)
    })
    if (paneMatch || !pty) {
      return paneMatch
    }
    // Why: the OSC producer can stamp a leaf or incarnation handle; use the same non-minting
    // inventory as worktree.ps so a tab-id remint can rejoin the still-live central row.
    for (const terminalHandle of this.getExistingTerminalHandlesForPtyId(pty.ptyId)) {
      const handleMatch = selectFreshAgentRowForMobileTab({
        paneKey,
        terminalHandle,
        hookRows: getRows(paneKey, terminalHandle)
      })
      if (handleMatch) {
        return handleMatch
      }
    }
    return null
  }

  protected findPtyForMobileTerminalTab(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean } = {}
  ): RuntimePtyWorktreeRecord | null {
    const snapshotPtyId = tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? null
    const paneKey = this.getMobileTerminalPaneKey(tab)
    if (snapshotPtyId) {
      const pty = this.ptysById.get(snapshotPtyId)
      if (!pty) {
        return null
      }
      // Why: persisted PTY ids can collide with unrelated provider ids after restart; only a matching spawn-time pane identity is safe to expose.
      if (this.mobileTerminalTabMatchesPty(worktreeId, tab, pty, paneKey)) {
        return pty
      }
      if (options.allowWorktreeOnlyMatch === true && pty.worktreeId === worktreeId) {
        const recorded = this.paneOfPty(pty)
        if (recorded.tabId === null && recorded.paneKey === null) {
          return pty
        }
      }
      return null
    }
    const paneKeys = new Set([`${tab.parentTabId}:${tab.leafId}`])
    if (tab.leafId === `pane:${FIRST_PANE_ID}`) {
      paneKeys.add(`${tab.parentTabId}:${FIRST_PANE_ID}`)
    }
    for (const pty of this.ptysById.values()) {
      const recorded = this.paneOfPty(pty)
      if (
        recorded.tabId === tab.parentTabId &&
        recorded.paneKey &&
        paneKeys.has(recorded.paneKey)
      ) {
        return pty
      }
    }
    return null
  }

  protected getMobileTerminalLeafPtyIds(tab: RuntimeMobileSessionTerminalTab): string[] {
    return [tab.ptyId, tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]].filter(
      (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0
    )
  }

  protected getMobileTerminalPaneKey(tab: RuntimeMobileSessionTerminalTab): string {
    if (isTerminalLeafId(tab.leafId)) {
      return makePaneKey(tab.parentTabId, tab.leafId)
    }
    const legacyPaneId = /^pane:(\d+)$/.exec(tab.leafId)?.[1] ?? null
    return `${tab.parentTabId}:${legacyPaneId ?? tab.leafId}`
  }

  protected mobileTerminalTabMatchesPty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    pty: RuntimePtyWorktreeRecord,
    paneKey = this.getMobileTerminalPaneKey(tab)
  ): boolean {
    if (pty.worktreeId !== worktreeId) {
      return false
    }
    const recorded = this.paneOfPty(pty)
    return recorded.tabId === tab.parentTabId && recorded.paneKey === paneKey
  }

  // Why: group address resolution (Section 4.5) queries per-handle status and must not throw on stale handles; return null on any error.
  async getAgentStatusForHandle(handle: string): Promise<string | null> {
    // A structured worker has no pane and no title, so every PTY probe below answers null and
    // `@idle` would enumerate it and then silently drop it. Its status is the journal's, read
    // through a conversation the idle sweep may have closed.
    const structured = await structuredWorkerHandleAgentStatus(handle, this._orchestrationDb)
    if (structured !== undefined) {
      return structured
    }
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      return this.getTerminalAgentStatusSnapshot(handle, ptyId).titleStatus
    } catch {
      return null
    }
  }

  getAgentStatusOrchestrationContextForPaneKey(
    paneKey: string
  ): AgentStatusOrchestrationContext | undefined {
    const handle = this.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      return undefined
    }
    return this.agentOrchestrationProjection.getForHandle(handle, undefined, { paneKey })
  }

  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return this.getTerminalHandleForPaneKey(paneKey) ?? undefined
  }

  getTerminalHandleForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : undefined
    if (leaf?.ptyId && leaf.connected) {
      return this.issueHandle(leaf)
    }
    const panePty = this.getPtyRecordForPaneKey(paneKey)
    if (panePty?.connected) {
      return this.issuePtyHandle(panePty)
    }
    if (leaf?.ptyId) {
      return this.issueHandle(leaf)
    }
    return panePty ? this.issuePtyHandle(panePty) : null
  }
}
