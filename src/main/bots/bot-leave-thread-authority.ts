// Whether a bot's running turn may leave its Slack thread (`orca bot reply --leave-thread`): read
// from Orca's own record of that turn, never the model's say-so. Only the turn now running counts,
// never an earlier one a worker's report would read back to, and every message it took must be a
// person who can ask the bot in this thread, or the owner typing in Orca.
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRunningAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { personSendsOf, typedInOrcaByPerson, type PersonSends } from './bot-typed-in-orca'
import { isRootTurnRecord, turnMessages } from './bot-turn-messages'
import { askedInThread } from '../external-conversations/external-conversation-leave-eligibility'

/** stale: no turn is running, or it took no message. mixed: it took a message that isn't from a
 *  person who can ask the bot here (another app, a bot, an automation, agent mail, someone Orca
 *  can't name, or a batch with any of these). */
export type LeaveThreadRefusal = 'leave_refused_stale' | 'leave_refused_mixed'

type Conversation = { source: string; externalId: string }

function eligible(
  item: AgentJournalRenderItem,
  sends: PersonSends,
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
    return typedInOrcaByPerson(item, sends)
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
  const turn = items.findLast(isRootTurnRecord)
  if (!turn || !isRunningAgentJournalTurn(turn.body)) {
    return 'leave_refused_stale'
  }
  const [messages = []] = turnMessages(items, submissions, [turn])
  if (messages.length === 0) {
    return 'leave_refused_stale'
  }
  const sends = personSendsOf(submissions)
  return messages.every((item) => eligible(item, sends, conversation))
    ? null
    : 'leave_refused_mixed'
}
