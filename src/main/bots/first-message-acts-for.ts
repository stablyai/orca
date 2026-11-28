import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  distinctAskers,
  OWNER_ACTS_FOR,
  type BotRequestAsker
} from '../../shared/bots/bot-acts-for'
import { runActsFor } from '../../shared/bots/bot-home-of'
import { carriedAskersOf, stampedPerson } from './bot-stamped-askers'
import { isRootUserMessage } from './bot-turn-messages'

/**
 * Whom a conversation Orca has no record for acts for, read from its first message: the person the
 * cloud stamped, the people a bot request was for, or the owner for the owner's own message, an event
 * no one asked through and an automation's prompt (from automations made before Orca recorded who made
 * them). Null before any message.
 */
export function firstMessageActsFor(
  items: readonly AgentJournalRenderItem[],
  lookups: {
    botRequestAskers: (messageId: string) => BotRequestAsker[] | null
    conversationWorkspaceId: string | null
    personName?: (accountId: string) => string | null
  }
): BotRequestAsker[] | null {
  const first = items.find(isRootUserMessage)
  if (!first || first.body.kind !== 'message') {
    return null
  }
  const { body } = first
  if (body.from) {
    const mail = body.from.orchestration
    const requested =
      mail?.message === 'mail-notice'
        ? mail.messages.flatMap((message) => lookups.botRequestAskers(message.messageId) ?? [])
        : []
    return requested.length > 0 ? distinctAskers(requested) : [...OWNER_ACTS_FOR]
  }
  const carried = carriedAskersOf(body, lookups.conversationWorkspaceId)
  // A run acts for whom its automation was made for: a teammate's, them.
  const own: BotRequestAsker[] = body.asker
    ? [stampedPerson(body.asker, lookups.conversationWorkspaceId)]
    : body.origin === 'connector' && !body.memorySource
      ? [{ kind: 'unknown' }]
      : body.automationRun
        ? [...runActsFor(body.automationRun, lookups.personName ?? (() => null))]
        : [...OWNER_ACTS_FOR]
  return carried.length > 0 ? distinctAskers([...own, ...carried]) : own
}
