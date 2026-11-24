// Whether a bot's running turn may leave its Slack thread (`orca bot reply --leave-thread`): read
// from Orca's own record of that turn, never the model's say-so. Only the turn now running counts,
// never an earlier one a worker's report would read back to, and every message it took must be a
// person who can ask the bot in this thread, or the owner typing in Orca.
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../shared/agent-session/requests/structured-agent-session-command-entry'
import { structuredAgentTurnAnchors } from '../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import {
  isRunningAgentJournalTurn,
  readAgentJournalTurn
} from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { typedInOrcaByPerson } from './bot-typed-in-orca'
import { askedInThread } from '../external-conversations/external-conversation-leave-eligibility'

/** stale: no turn is running, or it took no message. mixed: it took a message that isn't from a
 *  person who can ask the bot here (another app, a bot, an automation, agent mail, someone Orca
 *  can't name, or a batch with any of these). */
export type LeaveThreadRefusal = 'leave_refused_stale' | 'leave_refused_mixed'

type Conversation = { source: string; externalId: string }

function isRootUserMessage(item: AgentJournalRenderItem): boolean {
  return (
    item.body.kind === 'message' &&
    item.body.role === 'user' &&
    isRootAgentJournalItem(item) &&
    !isStructuredAgentSessionCommandEntry(item.body)
  )
}

function eligible(
  item: AgentJournalRenderItem,
  submissions: readonly AgentJournalSubmission[],
  conversation: Conversation
): boolean {
  const body = item.body
  if (body.kind !== 'message') {
    return false
  }
  // Another bot's request or a worker's report: agent mail.
  if (body.from) {
    return false
  }
  if (body.origin === undefined) {
    return typedInOrcaByPerson(item, submissions)
  }
  if (body.origin !== 'connector' || body.memorySource || !body.asker) {
    return false
  }
  return (
    askedInThread(body.asker, conversation.externalId) &&
    body.connectorConversation?.source === conversation.source &&
    body.connectorConversation.externalId === conversation.externalId &&
    // Every message of its batch was such a person's too, as Orca found when it delivered it.
    body.leaveEligible === true
  )
}

/** Why the running turn can't leave `conversation`; null when it can. */
export function leaveThreadRefusal(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  conversation: Conversation
): LeaveThreadRefusal | null {
  const turns = items.filter(
    (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)
  )
  const turn = turns.at(-1)
  if (!turn || !isRunningAgentJournalTurn(turn.body)) {
    return 'leave_refused_stale'
  }
  // An opener found by journal order is never a message from before the turn ahead of it.
  const previous = turns.at(-2)
  const after = previous ? items.indexOf(previous) : -1
  const opener = structuredAgentTurnAnchors(items, submissions).get(turn.itemId)
  const messages = items.filter(
    (item, index) =>
      isRootUserMessage(item) &&
      ((item.itemId === opener && index > after) ||
        (item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turn.itemId))
  )
  if (messages.length === 0) {
    return 'leave_refused_stale'
  }
  return messages.every((item) => eligible(item, submissions, conversation))
    ? null
    : 'leave_refused_mixed'
}
