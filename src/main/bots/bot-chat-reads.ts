// What bot background work reads from a bot's chats: bounded journal windows, never a whole chat.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { indexBotGroupJournal } from '../../shared/bots/bot-group'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { requireStructuredHost } from './bot-chat-session'
import type { JournalOperationWindowAnchors } from '../native-chat/agent-session-journal/journal-domain-operation-window'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { type BotChatJournal, NO_BOT_MEMORY_SOURCES } from './bot-turn-rows'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'

export type BotChatReads = {
  /** At least every item observed at or after `since`, with the other items of their turns; callers
   *  still filter by time. */
  messagesSince: (sessionId: string, since: number) => Promise<readonly AgentJournalRenderItem[]>
  /** The items of the turns these group operations opened, keyed by operation. */
  turnItems: (
    sessionId: string,
    turns: readonly { operationId: string; workerDispatchIds?: readonly string[] }[]
  ) => Promise<Map<string, AgentJournalRenderItem[]>>
}

/** A bot's chats as its turn ends read them, from the installed host; nothing before one is. */
export function botChatJournal(
  reads: (
    sessionId: string
  ) => Promise<Pick<JournalSqlReads, 'botMemorySources' | 'turnRanSince'> | null> = async (
    sessionId
  ) => (await getStructuredAgentSessionHost()?.journalReads(sessionId)) ?? null
): BotChatJournal {
  return {
    sourcesAfter: async (sessionId, after) =>
      (await (await reads(sessionId))?.botMemorySources(after)) ?? NO_BOT_MEMORY_SOURCES,
    turnRanSince: async (sessionId, opened) =>
      (await (await reads(sessionId))?.turnRanSince(opened)) ?? false
  }
}

export function botChatReads(runtime: OrcaRuntimeService): BotChatReads {
  const window = async (sessionId: string, anchors: JournalOperationWindowAnchors) =>
    (
      await (
        await (await requireStructuredHost(runtime)).journalReads(sessionId)
      ).operationWindow(anchors)
    ).snapshot
  return {
    messagesSince: async (sessionId, since) =>
      (await window(sessionId, { observedSince: since })).items,
    turnItems: async (sessionId, turns) => {
      const read = indexBotGroupJournal(
        await window(sessionId, { operationIds: turns.map((turn) => turn.operationId) })
      )
      return new Map(
        turns.map((turn) => [turn.operationId, read(turn.operationId, turn.workerDispatchIds)])
      )
    }
  }
}
