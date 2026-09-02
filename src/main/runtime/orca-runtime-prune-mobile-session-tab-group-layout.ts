// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from './orca-runtime-schedule-mobile-session-tabs-changed'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { mergeMobileSessionTabGroups } from './mobile-session-tab-merge'
import { buildHeadlessMobileSessionTabGroups } from './mobile-session-layout-projection'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import type {
  AgentStatusEntry,
  AgentStatusIpcPayload,
  AgentStatusOrchestrationContext
} from '../../shared/agent-status-types'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import { FIRST_PANE_ID } from '../../shared/pane-key'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { copySleepingAgentLaunchConfig } from './runtime-agent-launch-resolution'

export class OrcaRuntimeWithPruneMobileSessionTabGroupLayout extends OrcaRuntimeWithScheduleMobileSessionTabsChanged {
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
    terminalTabs: readonly RuntimeMobileSessionTerminalTab[],
    activeTab: RuntimeMobileSessionTerminalTab | null
  ): RuntimeMobileSessionTabGroup[] {
    return mergeMobileSessionTabGroups(worktreeId, groups, terminalTabs, activeTab)
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
    return projectRuntimeMobileSessionTabs(snapshot, this.getMobileSessionProjectionHost())
  }

  protected getMobileSessionProjectionHost(): RuntimeMobileSessionProjectionHost {
    return {
      tabs: this.tabs,
      leaves: this.leaves,
      ptysById: this.ptysById,
      getLiveBrowserTabs: (worktreeId) => this.getLiveBrowserTabsByPageId(worktreeId),
      getProviderSessionRows: (paneKey) => this.getAgentProviderSessionRowsForPaneFn?.(paneKey),
      getProviderSessionSnapshot: () => this.getAgentProviderSessionSnapshotFn?.() ?? [],
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId),
      findPty: (worktreeId, tab, options) =>
        this.findPtyForMobileTerminalTab(worktreeId, tab, options),
      getRetainedStatus: (paneKey, pty, tab) =>
        this.getFreshRetainedAgentStatusForMobileTab(paneKey, pty, tab),
      getTrackedTitle: (ptyId) => this.getUnpersistedTrackedTitleForPty(ptyId),
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
    return buildRuntimeMobileAgentStatus(pty, tab, terminalHandle, retained, getHookRowsForPane, {
      getPaneKey: (candidate) => this.getMobileTerminalPaneKey(candidate),
      getLeaf: (candidate) =>
        this.leaves.get(this.getLeafKey(candidate.parentTabId, candidate.leafId)) ?? null,
      getTrackedTitle: (ptyId) => this.getUnpersistedTrackedTitleForPty(ptyId)
    })
  }

  protected getFreshRetainedAgentStatusForMobileTab(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimeAgentRowSnapshot | null {
    return this.agentRows.getFreshForMobile(paneKey, pty, tab)
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
      if (
        options.allowWorktreeOnlyMatch === true &&
        pty.worktreeId === worktreeId &&
        pty.tabId === null &&
        pty.paneKey === null
      ) {
        return pty
      }
      return null
    }
    const paneKeys = new Set([`${tab.parentTabId}:${tab.leafId}`])
    if (tab.leafId === `pane:${FIRST_PANE_ID}`) {
      paneKeys.add(`${tab.parentTabId}:${FIRST_PANE_ID}`)
    }
    for (const pty of this.ptysById.values()) {
      if (pty.tabId === tab.parentTabId && pty.paneKey && paneKeys.has(pty.paneKey)) {
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
    return pty.worktreeId === worktreeId && pty.tabId === tab.parentTabId && pty.paneKey === paneKey
  }

  // Why: group address resolution (Section 4.5) queries per-handle status and must not throw on stale handles; return null on any error.
  getAgentStatusForHandle(handle: string): string | null {
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
    return this.agentOrchestrationProjection.getForHandle(handle)
  }

  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined {
    return this.getTerminalHandleForPaneKey(paneKey) ?? undefined
  }

  getAgentStatusLaunchConfigForPaneKey(
    paneKey: string,
    args?: { launchToken?: string }
  ): SleepingAgentLaunchConfig | undefined {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    if (!pty?.launchConfig) {
      return undefined
    }
    if (pty.launchToken === null || pty.launchToken !== args?.launchToken) {
      return undefined
    }
    return copySleepingAgentLaunchConfig(pty.launchConfig)
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
