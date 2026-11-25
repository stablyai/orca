// The chat-tab tidy on a runtime: its reads, the window's consent, the background hide, read-back and
// repair, and its ticker. It rides the automation scheduler's minute tick (see BotChatTabTidyTicker).
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { Bot } from '../../shared/bot-types'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { savedSessionId } from '../runtime/agent-session/lifecycle/saved-structured-agent-session-restoration'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface
} from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { createCanonicalOrcaSessionResolver } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { pageBotRequestChats } from '../runtime/orchestration/db/bot-requests/bot-request-chats-store'
import { readRecoveryCapsuleCustody } from '../runtime/agent-session/records/agent-session-recovery-capsule-custody'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { showBotSessionTab } from './bot-session-tab-show'
import { chatLive } from './bot-chat-tree-rows'
import {
  BOT_CHAT_TAB_IDLE_MS,
  BotChatTabTidyTicker,
  type BotChatTabAdmission,
  type BotChatTabCandidate,
  type BotChatTabLocated,
  type BotChatTabPassTabs,
  type BotChatTabRow,
  type BotChatTabTidyHost
} from './bot-chat-tab-tidy'
import { isBotRequestChat, readBotChatTabFacts } from './bot-chat-tab-tidy-facts'

const OPEN_ITEM_STATUSES: readonly BotItemStatus[] = ['planned', 'working', 'waiting', 'needs_you']

const keep = (why: string) => ({ kind: 'keep' as const, why })

export function runtimeBotChatTabTidyHost(runtime: OrcaRuntimeService): BotChatTabTidyHost {
  const botById = (botId: string): Bot | undefined =>
    runtime.bots.list().find((bot) => bot.id === botId)
  return {
    page: (after, limit) => pageBotRequestChats(runtime.getOrchestrationDb(), after, limit),
    locate: (chatId, tabs) => locate(runtime, chatId, tabs),
    admit: (candidate) => admit(runtime, candidate),
    custody: async () => {
      const capsule = getStructuredAgentSessionHost()?.deps.recoveryCapsule
      // No capsule: no restart recovery exists to hold.
      return capsule ? readRecoveryCapsuleCustody(capsule, Date.now()) : new Map()
    },
    consent: (candidate) =>
      runtime.askChatTabAutomaticClose(candidate.workspaceId, candidate.tabId, {
        keptIfTouchedSince: Date.now() - BOT_CHAT_TAB_IDLE_MS
      }),
    hide: async (candidate, check) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new Error('chat host not installed')
      }
      const surface = captureStructuredSessionSurface(host, candidate.tabSessionId, runtime)
      await retireCapturedStructuredSessionSurface(
        host,
        candidate.tabSessionId,
        surface,
        runtime,
        true,
        { admit: check }
      )
    },
    state: (candidate) => {
      const host = getStructuredAgentSessionHost()
      try {
        if (!host) {
          return 'unknown'
        }
        if (host.isSessionTabVisible(candidate.tabSessionId)) {
          return 'visible'
        }
        return host.deps.store.isSessionInBackground?.(candidate.tabSessionId) === true
          ? 'background'
          : 'unknown'
      } catch {
        return 'unknown'
      }
    },
    listed: async (candidate) =>
      (await runtime.listChatSessionTabs(candidate.workspaceId)).some(
        (tab) => tab.tabId === candidate.tabId || tab.sessionId === candidate.tabSessionId
      ),
    retireListing: async (candidate) => {
      const presentation = runtime.captureStructuredAgentSessionPresentation(candidate.tabSessionId)
      runtime.retireStructuredAgentSessionTabFromSnapshot(
        candidate.tabSessionId,
        candidate.tabId,
        candidate.workspaceId
      )
      runtime.removeCapturedStructuredSessionSavedTabs(candidate.tabSessionId, presentation.saved)
    },
    reveal: async (candidate) => {
      const bot = botById(candidate.botId)
      if (!bot) {
        throw new Error('bot_not_found')
      }
      await showBotSessionTab(runtime, bot, candidate.tabSessionId)
    },
    changed: (botIds) => runtime.notifyBotsChanged({ botIds, kinds: ['chats'] }),
    pause: () => new Promise((resolve) => setImmediate(resolve)),
    now: () => Date.now(),
    warn: (message, error) => console.warn(message, error)
  }
}

/** The marked chat's bot, lineage and one tab, cheapest reads first; anything off keeps it. */
async function locate(
  runtime: OrcaRuntimeService,
  chatId: string,
  tabsCache: BotChatTabPassTabs
): Promise<BotChatTabLocated> {
  const store = readAgentSessionRecordStore()
  const root = store?.getRecord(chatId)
  if (!store || !root) {
    return keep('no-record')
  }
  // A chat with no name or no turn lists in Chats only while its tab is open: it keeps it.
  if (!root.conversationName || !root.lastTurn) {
    return keep('blank')
  }
  const bot = botOfHomeWorkspace(runtime.bots.list(), root.location.workspaceId)
  const rootOf = createCanonicalOrcaSessionResolver(store)
  if (
    !bot ||
    isBotGroupMemberSession(chatId) ||
    (bot.chatSessionId !== null &&
      bot.chatSessionId !== undefined &&
      rootOf(bot.chatSessionId) === chatId)
  ) {
    return keep('not-a-side-chat')
  }
  const running = resolveLineageRunningSession(store, chatId)
  if (running.kind !== 'here') {
    return keep('lineage')
  }
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  let listing = tabsCache.get(workspaceId)
  if (!listing) {
    listing = runtime.listChatSessionTabs(workspaceId)
    tabsCache.set(workspaceId, listing)
  }
  const mine = (await listing).filter((tab) => rootOf(tab.sessionId) === chatId)
  if (mine.length !== 1) {
    return keep(mine.length === 0 ? 'no-tab' : 'several-tabs')
  }
  const [tab] = mine
  const focused = lastFocusedAt(runtime, workspaceId, tab)
  if (
    tab.isActive ||
    tab.isPinned === true ||
    (focused !== null && Date.now() - focused < BOT_CHAT_TAB_IDLE_MS)
  ) {
    return keep('tab-in-use')
  }
  return {
    kind: 'candidate',
    chatId,
    botId: bot.id,
    workspaceId,
    lineage: [...new Set([...running.lineage, tab.sessionId])],
    tabSessionId: tab.sessionId,
    tabId: tab.tabId
  }
}

function lastFocusedAt(
  runtime: OrcaRuntimeService,
  workspaceId: string,
  tab: BotChatTabRow
): number | null {
  const focused = (
    runtime.getWorkspaceSessionForWorktree(workspaceId)?.unifiedTabs?.[workspaceId] ?? []
  )
    .filter((entry) => entry.id === tab.tabId || savedSessionId(entry) === tab.sessionId)
    .flatMap((entry) => (entry.lastFocusedAt === undefined ? [] : [entry.lastFocusedAt]))
  return focused.length > 0 ? Math.max(...focused) : null
}

/** Every read the tidy decides a chat by, fail closed. The sync part also runs inside the hide's write;
 *  the whole of it runs again once the hide committed (bot-chat-tab-tidy.ts settleHide). */
async function admit(
  runtime: OrcaRuntimeService,
  candidate: BotChatTabCandidate
): Promise<BotChatTabAdmission> {
  const db = runtime.getOrchestrationDb()
  const syncWhy = (): string | null => {
    if (!isBotRequestChat(db, candidate.chatId)) {
      return 'not-a-request-chat'
    }
    const store = readAgentSessionRecordStore()
    const records = candidate.lineage.map((id) => store?.getRecord(id))
    const root = store?.getRecord(candidate.chatId)
    if (!root?.conversationName || !root.lastTurn) {
      return 'blank'
    }
    const running = resolveLineageRunningSession(store, candidate.chatId)
    if (running.kind !== 'here' || running.lineage.some((id) => !candidate.lineage.includes(id))) {
      return 'lineage'
    }
    if (records.some((record) => record?.lastTurn?.state === 'open')) {
      return 'open-turn'
    }
    const facts = readBotChatTabFacts(db, {
      rootChatId: candidate.chatId,
      lineage: candidate.lineage
    })
    if (facts.holds.length > 0) {
      return facts.holds.join(',')
    }
    // Epoch ms throughout: turn times, mail (julian day converted), record updates as the fallback.
    const times = [
      ...records.flatMap((record) => (record?.lastTurn ? [record.lastTurn.at] : [])),
      ...(facts.lastMailAt === null ? [] : [facts.lastMailAt])
    ]
    const activeAt = times.length > 0 ? Math.max(...times) : root.updatedAt
    if (Date.now() - activeAt < BOT_CHAT_TAB_IDLE_MS) {
      return 'active'
    }
    return sessionsSettled(runtime, candidate.lineage) ? null : 'busy'
  }
  const first = syncWhy()
  if (first) {
    return keep(first)
  }
  const { counts } = await runtime.botItems.store().list({
    botId: candidate.botId,
    statuses: OPEN_ITEM_STATUSES,
    chatIds: candidate.lineage,
    limit: 1
  })
  if (OPEN_ITEM_STATUSES.some((status) => (counts[status] ?? 0) > 0)) {
    return keep('item')
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return keep('no-host')
  }
  for (const sessionId of candidate.lineage) {
    if (await host.reads.heldInput(sessionId)) {
      return keep('held-input')
    }
  }
  return {
    kind: 'go',
    check: () => {
      const why = syncWhy()
      if (why) {
        throw new Error(`chat tab kept: ${why}`)
      }
    }
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
