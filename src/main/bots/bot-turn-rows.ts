// What a bot chat's turn rows say about its turns: who opened one, when, and whether another ran.

import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalTurnOpener,
  type AgentJournalTurnOpenerRows
} from '../../shared/agent-session/journal/agent-session-journal-turn-opener'
import {
  type BotMemorySources,
  botMemorySourceLabel,
  botMemorySourcesOf
} from '../../shared/bots/bot-memory-source'

/** The ended turn was opened by the owner's words or card click: not Orca's kickoff, a connector's
 *  message, an automation run's prompt or another agent's mail. A turn id can repeat; the last is it. */
export function ownerOpened(journal: AgentJournalTurnOpenerRows, turnId: string): boolean {
  const turn = journal.items.findLast(
    ({ body }) => body.kind === 'turn' && body.turnId === turnId && body.state !== 'running'
  )
  const opener = turn?.body.kind === 'turn' ? turn.body.userItemId : undefined
  const body = opener ? agentJournalTurnOpener(journal, opener)?.body : undefined
  return (
    body?.kind === 'message' &&
    body.role === 'user' &&
    !body.from &&
    !body.memorySource &&
    (body.origin === undefined || body.origin === 'card-answer')
  )
}

/** When the ended turn was asked for; null when its row doesn't say. */
export function turnOpenedAt(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): number | null {
  const turn = items.findLast(({ body }) => body.kind === 'turn' && body.turnId === turnId)
  return turn?.body.kind === 'turn' ? (turn.body.requestedAt ?? turn.body.startedAt ?? null) : null
}

/** The ended turn's rows within `window`: from its opener on, when its row names one. */
export function turnRows(
  journal: AgentJournalTurnOpenerRows,
  turnId: string,
  window: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  const turn = journal.items.findLast(({ body }) => body.kind === 'turn' && body.turnId === turnId)
  const opener = turn?.body.kind === 'turn' ? turn.body.userItemId : undefined
  const from = opener ? agentJournalTurnOpener(journal, opener)?.sequence : undefined
  return from === undefined ? window : window.filter((item) => item.sequence >= from)
}

/** A bot's conversations as a turn end reads them, never more of a chat than the end needs. */
export type BotChatJournal = {
  /** Where the chat's person messages after `after` came from; all of them when null (a chat's
   *  first end since Orca started can't tell where its last end read through). Never its rows. */
  sourcesAfter: (sessionId: string, after: number | null) => Promise<BotMemorySources>
  /** Whether any of the chat's turns ran at some point since `opened` (any, when that is unknown). */
  turnRanSince: (sessionId: string, opened: number | null) => Promise<boolean>
}

export const NO_BOT_MEMORY_SOURCES: BotMemorySources = { places: [], urls: [] }

export const NO_BOT_CHAT_JOURNAL: BotChatJournal = {
  sourcesAfter: async () => NO_BOT_MEMORY_SOURCES,
  turnRanSince: async () => false
}

/** One of the bot's conversations at a turn end, and where its last end read through. */
export type BotTurnBeside = { sessionId: string; scannedThrough: number | null }

/** The bot's other conversations at a turn end, each read once and only when asked: where the facts
 *  the turn's window wrote came from, and whether no other turn ran beside it since `opened`. The
 *  ended chat's first end since start reads its whole history's sources, as its window opens there;
 *  `turn` is its rows after its last end otherwise. */
export function besideTurn(
  own: BotTurnBeside & { turn: readonly AgentJournalRenderItem[] },
  opened: number | null,
  chats: BotChatJournal,
  conversations: () => readonly BotTurnBeside[]
): { label: () => Promise<string | null>; alone: () => Promise<boolean> } {
  let listed: readonly BotTurnBeside[] | undefined
  const others = () => (listed ??= conversations())
  let source: Promise<string | null> | undefined
  let ranAlone: Promise<boolean> | undefined
  const turnSources = (): BotMemorySources => botMemorySourcesOf(own.turn.map(({ body }) => body))
  return {
    label: () =>
      (source ??= Promise.all([
        // Unread history may hold an outside source: no label beats crediting the owner. The turn's
        // own rows, already in that history, come after it.
        ...(own.scannedThrough === null ? [chats.sourcesAfter(own.sessionId, null)] : []),
        Promise.resolve(turnSources()),
        ...others().map(({ sessionId, scannedThrough }) =>
          chats.sourcesAfter(sessionId, scannedThrough).catch(() => NO_BOT_MEMORY_SOURCES)
        )
      ]).then(botMemorySourceLabel)),
    // A conversation that can't be read may have run beside it.
    alone: () =>
      (ranAlone ??= Promise.all(
        others().map(({ sessionId }) => chats.turnRanSince(sessionId, opened).catch(() => true))
      ).then((ran) => !ran.some(Boolean)))
  }
}
