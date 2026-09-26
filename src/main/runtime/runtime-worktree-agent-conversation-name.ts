import {
  getAgentRowConversationName,
  type ConversationNameTab
} from '../../shared/agent-row-conversation-name'
import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { AgentType } from '../../shared/agent-status-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

type OrchestrationParent = {
  parentPaneKey?: string | null
}

/**
 * Stable names for mobile worktree.ps agent rows. Desktop already resolves
 * these in the renderer; the phone only receives the ps payload (#20444).
 */
type UnifiedAgentNameTab = {
  id: string
  contentType: string
  customLabel: string | null
  label: string
  quickCommandLabel?: string | null
  aiVaultTitle?: ConversationNameTab['aiVaultTitle']
  generatedLabel?: string | null
  agentSessionAgent?: AgentType | null
}

export function resolveWorktreeAgentConversationNames(args: {
  sources: Iterable<RuntimeWorktreeAgentSource>
  tabsByWorktree: Record<string, readonly TerminalTab[]> | null | undefined
  /** Structured native-chat tabs live here, not in `tabsByWorktree`. */
  unifiedTabs?: Record<string, readonly UnifiedAgentNameTab[]> | null
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined> | null
  generatedTitlesEnabled: boolean
  orchestrationByPaneKey: Record<string, OrchestrationParent> | null | undefined
}): Map<string, string> {
  const sources = [...args.sources]
  const tabsById = indexConversationTabs(args.tabsByWorktree, args.unifiedTabs)
  const sourcesPerTab = countSourcesPerTab(sources)
  const names = new Map<string, string>()
  for (const source of sources) {
    const tabId = source.tabId ?? parsePaneKey(source.paneKey)?.tabId
    if (!tabId || sharesParentTab(source, tabId, args.orchestrationByPaneKey)) {
      continue
    }
    const tab = tabsById.get(tabId)
    if (!tab) {
      continue
    }
    const name = getAgentRowConversationName(
      tab,
      source.agentType as AgentType | null,
      args.generatedTitlesEnabled,
      paneLiveTitleForSource(
        source,
        tabId,
        sourcesPerTab.get(tabId) ?? 0,
        args.terminalLayoutsByTabId
      ),
      source.providerSessionId
    )
    if (name) {
      names.set(source.paneKey, name)
    }
  }
  return names
}

function indexConversationTabs(
  tabsByWorktree: Record<string, readonly TerminalTab[]> | null | undefined,
  unifiedTabs: Record<string, readonly UnifiedAgentNameTab[]> | null | undefined
): Map<string, ConversationNameTab> {
  const tabsById = new Map<string, ConversationNameTab>()
  if (tabsByWorktree) {
    for (const tabs of Object.values(tabsByWorktree)) {
      for (const tab of tabs) {
        tabsById.set(tab.id, tab)
      }
    }
  }
  if (!unifiedTabs) {
    return tabsById
  }
  for (const tabs of Object.values(unifiedTabs)) {
    for (const tab of tabs) {
      if (tab.contentType !== 'agent-session' || tabsById.has(tab.id)) {
        continue
      }
      tabsById.set(tab.id, conversationNameTabFromUnified(tab))
    }
  }
  return tabsById
}

function conversationNameTabFromUnified(tab: UnifiedAgentNameTab): ConversationNameTab {
  return {
    customTitle: tab.customLabel,
    quickCommandLabel: tab.quickCommandLabel,
    aiVaultTitle: tab.aiVaultTitle,
    generatedTitle: tab.generatedLabel,
    title: tab.label,
    // "Claude Chat" is the empty structured-tab placeholder, not a conversation name.
    defaultTitle: tab.agentSessionAgent ? defaultAgentChatLabel(tab.agentSessionAgent) : undefined
  }
}

function paneLiveTitleForSource(
  source: RuntimeWorktreeAgentSource,
  tabId: string,
  agentCount: number,
  layouts: Record<string, TerminalLayoutSnapshot | undefined> | null | undefined
): string | null | undefined {
  const layout = layouts?.[tabId]
  if (layout?.root?.type === 'split') {
    const leafId = parsePaneKey(source.paneKey)?.leafId
    // tab.title belongs to the focused leaf. Another leaf must not wear it.
    return leafId && layout.activeLeafId === leafId ? undefined : null
  }
  return agentCount > 1 ? null : undefined
}

function countSourcesPerTab(sources: readonly RuntimeWorktreeAgentSource[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const source of sources) {
    const tabId = source.tabId ?? parsePaneKey(source.paneKey)?.tabId
    if (!tabId) {
      continue
    }
    counts.set(tabId, (counts.get(tabId) ?? 0) + 1)
  }
  return counts
}

function sharesParentTab(
  source: RuntimeWorktreeAgentSource,
  tabId: string,
  orchestrationByPaneKey: Record<string, OrchestrationParent> | null | undefined
): boolean {
  const parentPaneKey = orchestrationByPaneKey?.[source.paneKey]?.parentPaneKey
  if (!parentPaneKey) {
    return false
  }
  return parsePaneKey(parentPaneKey)?.tabId === tabId
}
