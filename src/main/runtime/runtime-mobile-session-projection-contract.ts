import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type {
  BrowserTabInfo,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeSyncedTab
} from '../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export type RuntimeMobileSessionProjectionHost = {
  tabs: ReadonlyMap<string, RuntimeSyncedTab>
  leaves: ReadonlyMap<string, RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  getLiveBrowserTabs(worktreeId: string): Map<string, BrowserTabInfo>
  getProviderSessionRows(paneKey: string): AgentStatusIpcPayload[] | undefined
  getProviderSessionSnapshot(): AgentStatusIpcPayload[]
  getLeafKey(tabId: string, leafId: string): string
  findPty(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    options: { allowWorktreeOnlyMatch?: boolean }
  ): RuntimePtyWorktreeRecord | null
  getRetainedStatus(
    paneKey: string,
    pty: RuntimePtyWorktreeRecord | null,
    tab: RuntimeMobileSessionTerminalTab
  ): RuntimeAgentRowSnapshot | null
  getTrackedTitle(ptyId: string | null): string | null
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
