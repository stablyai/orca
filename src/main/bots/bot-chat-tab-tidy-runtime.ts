// The chat-tab tidy on a runtime: its reads, the window's consent, the background hide, and its ticker.
// It rides the automation scheduler's minute tick (see BotChatTabTidyTicker for when a pass is due).
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { savedSessionId } from '../runtime/agent-session/lifecycle/saved-structured-agent-session-restoration'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface
} from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotChatTreeParts, runtimeBotChatTreeHost } from './bot-chat-tree-host'
import { chatLive } from './bot-chat-tree-rows'
import {
  BOT_CHAT_TAB_IDLE_MS,
  BotChatTabTidyTicker,
  type BotChatTabAdmission,
  type BotChatTabTidyHost
} from './bot-chat-tab-tidy'
import { isBotRequestChat, readBotChatTabFacts } from './bot-chat-tab-tidy-facts'

const OPEN_ITEM_STATUSES: readonly BotItemStatus[] = ['planned', 'working', 'waiting', 'needs_you']

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
    lastFocusedAt: (workspaceId, tab) => {
      const focused = (
        runtime.getWorkspaceSessionForWorktree(workspaceId)?.unifiedTabs?.[workspaceId] ?? []
      )
        .filter((entry) => entry.id === tab.tabId || savedSessionId(entry) === tab.sessionId)
        .flatMap((entry) => (entry.lastFocusedAt === undefined ? [] : [entry.lastFocusedAt]))
      return focused.length > 0 ? Math.max(...focused) : null
    },
    admission: (botId, chat, tab) => chatAdmission(runtime, botId, chat, tab.sessionId),
    consent: (workspaceId, tab) =>
      runtime.askChatTabAutomaticClose(workspaceId, tab.tabId, {
        keptIfTouchedSince: Date.now() - BOT_CHAT_TAB_IDLE_MS
      }),
    hide: async (tab, admit) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return 'error'
      }
      const surface = captureStructuredSessionSurface(host, tab.sessionId, runtime)
      const result = await retireCapturedStructuredSessionSurface(
        host,
        tab.sessionId,
        surface,
        runtime,
        true,
        { admit }
      )
      return result.committed ? 'committed' : result.error === undefined ? 'refused' : 'error'
    },
    changed: (botIds) => runtime.notifyBotsChanged({ botIds, kinds: ['chats'] }),
    pause: () => new Promise((resolve) => setImmediate(resolve)),
    now: () => Date.now(),
    warn: (message, error) => console.warn(message, error)
  }
}

const keep = (why: string): BotChatTabAdmission => ({ kind: 'keep', why })

/** Every read the tidy decides a chat by, fail closed. The sync part runs again inside the hide's
 *  write; open items are read once here (the items store is async), fenced by the chat being at rest:
 *  an item's chat is the one whose turn made it, and no turn runs while it rests. */
async function chatAdmission(
  runtime: OrcaRuntimeService,
  botId: string,
  chat: BotChatTreeChat,
  tabSessionId: string
): Promise<BotChatTabAdmission> {
  const db = runtime.getOrchestrationDb()
  if (!isBotRequestChat(db, chat.chatId)) {
    return keep('not-a-request-chat')
  }
  const syncWhy = (): string | null => {
    const store = readAgentSessionRecordStore()
    const root = store?.getRecord(chat.chatId)
    // A chat with no name or no turn lists in Chats only while its tab is open: it keeps it.
    if (!root?.conversationName || !root.lastTurn) {
      return 'blank'
    }
    const running = resolveLineageRunningSession(store, chat.chatId)
    if (running.kind !== 'here') {
      return 'lineage'
    }
    const lineage = [...new Set([...running.lineage, tabSessionId])]
    const facts = readBotChatTabFacts(db, { rootChatId: chat.chatId, lineage })
    if (facts.holds.length > 0) {
      return facts.holds.join(',')
    }
    // Read now, not from the pass's list: every session's last turn and the newest mail.
    const turns = lineage.flatMap((id) => {
      const turn = store?.getRecord(id)?.lastTurn
      return turn ? [turn] : []
    })
    if (turns.some((turn) => turn.state === 'open')) {
      return 'open-turn'
    }
    const turnAts = turns.map((turn) => turn.at)
    const activeAt = Math.max(
      chat.lastActiveAt,
      facts.lastMailAt ?? Number.NEGATIVE_INFINITY,
      ...turnAts
    )
    if (Date.now() - activeAt < BOT_CHAT_TAB_IDLE_MS) {
      return 'active'
    }
    return sessionsSettled(runtime, lineage) ? null : 'busy'
  }
  const first = syncWhy()
  if (first) {
    return keep(first)
  }
  const lineage = lineageOf(chat.chatId, tabSessionId)
  const { counts } = await runtime.botItems.store().list({
    botId,
    statuses: OPEN_ITEM_STATUSES,
    chatIds: lineage,
    limit: 1
  })
  if (OPEN_ITEM_STATUSES.some((status) => (counts[status] ?? 0) > 0)) {
    return keep('item')
  }
  if (await restartHeld(lineage)) {
    return keep('recovery')
  }
  return {
    kind: 'go',
    admit: () => {
      const why = syncWhy()
      if (why) {
        throw new Error(`chat tab kept: ${why}`)
      }
    }
  }
}

function lineageOf(rootChatId: string, tabSessionId: string): string[] {
  const running = resolveLineageRunningSession(readAgentSessionRecordStore(), rootChatId)
  return [...new Set([...running.lineage, tabSessionId])]
}

/** A restart recovery offer or failure still listed for any of these sessions; unreadable counts. */
async function restartHeld(sessionIds: readonly string[]): Promise<boolean> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return true
  }
  try {
    const [offers, failures] = await Promise.all([
      host.restartResume.list(),
      host.restartResume.listFailures()
    ])
    const listed = new Set([...offers, ...failures].map((row) => row.sessionId))
    return sessionIds.some((id) => listed.has(id))
  } catch {
    return true
  }
}

/** Fails closed: no chat host, or any session with an agent attached or starting, a delivery or mail
 *  on its way, a status row working or waiting on the owner, or a screen showing it. */
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
      host.reads.atRest(sessionId) &&
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
