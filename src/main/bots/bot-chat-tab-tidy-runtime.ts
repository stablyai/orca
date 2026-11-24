// The chat-tab tidy on a runtime: its reads, the "x" it closes a tab with, and when it runs. It rides
// the automation scheduler's minute tick, at most once an hour; the first pass, a while after launch,
// also clears the tabs that piled up before this existed.
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { savedSessionId } from '../runtime/agent-session/lifecycle/saved-structured-agent-session-restoration'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotChatTreeParts, runtimeBotChatTreeHost } from './bot-chat-tree-host'
import { chatLive } from './bot-chat-tree-rows'
import { BotChatTabTidyTicker, type BotChatTabTidyHost } from './bot-chat-tab-tidy'

const OPEN_ITEM_STATUSES: readonly BotItemStatus[] = ['planned', 'working', 'waiting', 'needs_you']
const OPEN_ITEMS_READ_LIMIT = 5000

export function runtimeBotChatTabTidyHost(runtime: OrcaRuntimeService): BotChatTabTidyHost {
  return {
    bots: () => runtime.bots.list(),
    chats: async (botId) => {
      const { tree, rootOf } = await readBotChatTreeParts(runtimeBotChatTreeHost(runtime), {
        botId
      })
      return { chats: tree.chats, rootOf }
    },
    tabs: (workspaceId) => runtime.listChatSessionTabs(workspaceId),
    openItemChats: async (botId, chatIds) => {
      const { items } = await runtime.botItems.store().list({
        botId,
        statuses: OPEN_ITEM_STATUSES,
        chatIds,
        limit: OPEN_ITEMS_READ_LIMIT
      })
      return new Set(items.map((item) => item.chatId))
    },
    settled: (sessionIds) => sessionsSettled(runtime, sessionIds),
    lastFocusedAt: (workspaceId, tab) => {
      const saved = runtime
        .getWorkspaceSessionForWorktree(workspaceId)
        ?.unifiedTabs?.[workspaceId]?.filter(
          (entry) => entry.id === tab.tabId || savedSessionId(entry) === tab.sessionId
        )
      const focused = (saved ?? []).flatMap((entry) =>
        entry.lastFocusedAt === undefined ? [] : [entry.lastFocusedAt]
      )
      return focused.length > 0 ? Math.max(...focused) : null
    },
    closeTab: async (workspaceId, tabId) => {
      const result = await runtime.closeMobileSessionTab(`id:${workspaceId}`, tabId, {
        reason: 'user'
      })
      if (result.refused) {
        throw new Error(`chat tab close refused: ${result.refusalReason ?? 'unknown'}`)
      }
    },
    now: () => Date.now(),
    warn: (message, error) => console.warn(message, error)
  }
}

/** Fails closed: no chat host, or any session starting, working, waiting on the owner or on a screen. */
function sessionsSettled(
  runtime: Pick<OrcaRuntimeService, 'getAgentStatusSnapshotFn'>,
  sessionIds: readonly string[]
): boolean {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return false
  }
  const rows = new Map<string, AgentStatusIpcPayload>(
    (runtime.getAgentStatusSnapshotFn?.() ?? []).map((row) => [row.paneKey, row])
  )
  return sessionIds.every(
    (sessionId) =>
      !host.reads.agentStarting(sessionId) &&
      !host.reads.startWindingDown(sessionId) &&
      !host.reads.viewed(sessionId) &&
      chatLive(rows.get(structuredAgentSessionStatusPaneKey(sessionId))) === 'idle'
  )
}

const tickers = new WeakMap<object, BotChatTabTidyTicker>()

export function runtimeBotChatTabTidy(runtime: OrcaRuntimeService): BotChatTabTidyTicker {
  let ticker = tickers.get(runtime)
  if (!ticker) {
    ticker = new BotChatTabTidyTicker(() => runtimeBotChatTabTidyHost(runtime))
    tickers.set(runtime, ticker)
  }
  return ticker
}
