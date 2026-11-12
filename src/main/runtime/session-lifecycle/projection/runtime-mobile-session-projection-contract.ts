import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { BrowserTabInfo } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedTab
} from '../../../../shared/runtime-session-contracts'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { RuntimeAgentRowSnapshot } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import type { TitleDisplayClear } from '../../workspaces/process-listing/runtime-worktree-status-projection'

export type RuntimeMobileSessionProjectionHost = {
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  getPtyAvailability(ptyId: string): boolean | null
  isSessionTitlePublisher(worktreeId: string, surfaceId: string): boolean
  getLiveBrowserTabs(worktreeId: string): Map<string, BrowserTabInfo>
  isRendererOwnedMobileBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean
  getProviderSessionRows(paneKey: string): AgentStatusIpcPayload[] | undefined
  getProviderSessionSnapshot(): AgentStatusIpcPayload[]
  getStatusRows(paneKey: string, terminalHandle: string | null): AgentStatusIpcPayload[]
  getLeafKey(tabId: string, leafId: string): string
  findPty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean }
  ): RuntimePtyWorktreeRecord | null
  getRetainedStatus(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab,
    getRows: (paneKey: string, terminalHandle: string | null) => AgentStatusIpcPayload[]
  ): RuntimeAgentRowSnapshot | null
  getTrackedTitle(ptyId: string | null): string | null
  /** Display-only clear of a PTY's native title; every title/status read here is display. */
  getTitleDisplayClear(ptyId: string | null): TitleDisplayClear | null
  issuePtyHandle(pty: RuntimePtyWorktreeRecord): string
  recordPty(
    ptyId: string,
    worktreeId: string,
    state: Partial<Pick<RuntimePtyWorktreeRecord, 'connected' | 'tabId' | 'paneKey'>>
  ): RuntimePtyWorktreeRecord
  buildPtyStatus(
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab,
    terminalHandle: string | null,
    retained: RuntimeAgentRowSnapshot | null,
    getRows: (paneKey: string) => AgentStatusIpcPayload[]
  ): { agentStatus: AgentStatusEntry } | Record<string, never>
  sanitizeGroups(
    groups: RuntimeMobileSessionTabGroup[] | undefined,
    tabs: RuntimeMobileSessionClientTab[]
  ): RuntimeMobileSessionTabGroup[] | undefined
  pruneGroupLayout(
    layout: TabGroupLayoutNode | null | undefined,
    validGroupIds: ReadonlySet<string>
  ): TabGroupLayoutNode | null
  collectTabIds(tabs: readonly RuntimeMobileSessionClientTab[]): Set<string>
}

export type RuntimeMobileSessionProjectionInput = {
  snapshot: RuntimeMobileSessionTabsSnapshot
  tabs: RuntimeMobileSessionClientTab[]
}
