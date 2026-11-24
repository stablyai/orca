// The chat-tab tidy on a runtime: its reads, the "x" it closes a tab with, and its ticker. It rides the
// automation scheduler's minute tick (see BotChatTabTidyTicker for when a pass is due).
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { savedSessionId } from '../runtime/agent-session/lifecycle/saved-structured-agent-session-restoration'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readAgentSessionRecordStore } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotChatTreeParts, runtimeBotChatTreeHost } from './bot-chat-tree-host'
import { chatLive } from './bot-chat-tree-rows'
import {
  BotChatTabTidyTicker,
  type BotChatTabAdmission,
  type BotChatTabTidyHost
} from './bot-chat-tab-tidy'
import { readBotChatTabFacts } from './bot-chat-tab-tidy-facts'

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
    admission: (botId, chatId, lineage) => chatAdmission(runtime, botId, chatId, lineage),
    restartHeld: async () => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return new Set()
      }
      const [offers, failures] = await Promise.all([
        host.restartResume.list(),
        host.restartResume.listFailures()
      ])
      return new Set([...offers, ...failures].map((row) => row.sessionId))
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
    closeTab: async (workspaceId, tab) => {
      // Any tab change since the pass read this one (brought forward, reordered, reopened) refuses.
      const now = (await runtime.listChatSessionTabs(workspaceId)).find(
        (row) => row.tabId === tab.tabId
      )
      if (!now || now.isActive || now.snapshotVersion !== tab.snapshotVersion) {
        return 'refused'
      }
      // The phone's "x": the window closes its tab, then the bot chat goes on in the background.
      const result = await runtime.closeMobileSessionTab(`id:${workspaceId}`, tab.tabId, {
        reason: 'user',
        ...(tab.publicationEpoch ? { expectedPublicationEpoch: tab.publicationEpoch } : {})
      })
      if (result.refused) {
        return 'refused'
      }
      return result.retirementConfirmed ? 'closed' : 'delegated'
    },
    changed: (botIds) => runtime.notifyBotsChanged({ botIds, kinds: ['chats'] }),
    pause: () => new Promise((resolve) => setImmediate(resolve)),
    now: () => Date.now(),
    warn: (message, error) => console.warn(message, error)
  }
}

/** Provenance, holds and mail from the orchestration records; open items counted exactly by the
 *  items store for the chat's sessions (no page of items stands in for their absence). */
async function chatAdmission(
  runtime: OrcaRuntimeService,
  botId: string,
  chatId: string,
  lineage: readonly string[]
): Promise<BotChatTabAdmission> {
  const facts = readBotChatTabFacts(runtime.getOrchestrationDb(), {
    chatId,
    lineage,
    chatCreatedAt: readAgentSessionRecordStore()?.getRecord(chatId)?.createdAt ?? null
  })
  if (!facts.requestChat || facts.holds.length > 0) {
    return facts
  }
  const { counts } = await runtime.botItems.store().list({
    botId,
    statuses: OPEN_ITEM_STATUSES,
    chatIds: lineage,
    limit: 1
  })
  const open = OPEN_ITEM_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
  return open > 0 ? { ...facts, holds: ['item'] } : facts
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
