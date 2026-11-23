// The card a send to an agent on a paired computer leaves in the asking chat: the same bot-request
// card bot-to-bot requests leave, naming that computer, its outcome read from this Orca's own record.
import { writeInChat } from '../../../../../bots/bot-chat-status-line'
import { isBotRequestPurpose } from '../../../../../bots/bot-request-policy'
import { isBotAnswer } from '../../../../../bots/bot-group-remote-answers'
import { parseBotAddress } from '../../../../../../shared/bot-roster'
import { parseOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import {
  botRequestCardBody,
  type BotRequestCard,
  type BotRequestCardReading
} from '../../../../../../shared/bots/bot-request-card'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { CLIENT_ENVIRONMENT_PREFIX } from '../../../../orchestration/federation/client-asks/client-ask-environment'

/** Writes the card once the send settles: a chat's question or handoff only, never a terminal's. */
export function clientAskCard(args: {
  asker: string
  to: string
  type: string | undefined
  subject: string
  client: { installationId: string; computer: string }
}): {
  write: (fields: Pick<BotRequestCard, 'messageId' | 'refusal'>) => void
  refused: (error: unknown) => void
} {
  const sessionId = parseOrcaSessionAddress(args.asker)
  const name = parseBotAddress(args.to)
  const write = (fields: Pick<BotRequestCard, 'messageId' | 'refusal'>): void => {
    if (!sessionId || !name || !isBotRequestPurpose(args.type) || args.type === 'status') {
      return
    }
    const card: BotRequestCard = {
      toBotId: name.slice(0, 200),
      toBotName: name.slice(0, 200),
      purpose: args.type,
      subject: args.subject.slice(0, 300),
      client: {
        installationId: args.client.installationId,
        computer: args.client.computer.slice(0, 200)
      },
      ...fields
    }
    writeInChat(sessionId, botRequestCardBody(card), 'bot-request')
  }
  return {
    write,
    refused: (error) => {
      if (error instanceof OrchestrationError) {
        write({ refusal: error.code })
      }
    }
  }
}

// The conversation an ask this Orca's agent sent a paired computer went out on.
const ISSUED_SQL = `SELECT i.dispatch_id FROM federation_relay_items i
  JOIN peer_mail_conversations c ON c.conversation_id = i.dispatch_id
  WHERE i.message_id = ? AND i.direction = 'to_worker' AND i.kind = 'client_ask'
    AND c.role = 'home' AND c.environment_id LIKE '${CLIENT_ENVIRONMENT_PREFIX}%'`

// The ask's thread as that conversation brought it back, and this Orca's own notices on it (an
// unpair or re-pair), which came over no conversation. Mail another conversation brought is not it.
const REPLIES_SQL = `SELECT m.id, m.body, m.payload, p.conversation_id FROM messages m
  LEFT JOIN peer_mail_messages p ON p.message_id = m.id
  WHERE m.thread_id = ?1 AND (p.conversation_id = ?2 OR p.conversation_id IS NULL)
  ORDER BY m.rowid`

/** How an ask to a paired computer's agent stands here: declined on that computer's notice, answered
 *  by its agent's answer, or not answered when its question settled without one (an unpair or
 *  re-pair notice, shown as the answer is). A handoff, which awaits no answer, takes its first reply
 *  from that computer. Only an ask this Orca sent reads as one, from its own conversation. */
export function readClientAskOutcome(
  db: OrchestrationDb,
  messageId: string
): BotRequestCardReading {
  const issued = db.db.prepare(ISSUED_SQL).get(messageId)
  if (!issued) {
    return { outcome: null, answer: null, mailIds: [], chatId: null }
  }
  const conversationId = String(issued.dispatch_id)
  const replies = db.db
    .prepare(REPLIES_SQL)
    .all(messageId, conversationId)
    .map((row) => ({
      id: String(row.id),
      body: String(row.body),
      payload: typeof row.payload === 'string' ? row.payload : null,
      fromComputer: row.conversation_id !== null
    }))
  // Only that computer answers or declines; a notice of this Orca's only settles a question.
  const returned = replies.filter((reply) => reply.fromComputer)
  const question = db.db
    .prepare('SELECT awaiting FROM peer_questions_out WHERE message_id = ? AND conversation_id = ?')
    .get(messageId, conversationId)
  const mailIds = replies.map((reply) => reply.id)
  const reading = (outcome: BotRequestCardReading['outcome'], answer?: string) => ({
    outcome,
    answer: answer ?? null,
    mailIds,
    chatId: null
  })
  if (returned.some((reply) => reply.id === `${messageId}_declined`)) {
    return reading('dropped')
  }
  const answer = question ? returned.find((reply) => isBotAnswer(reply, messageId)) : returned[0]
  if (answer) {
    return reading('answered', answer.body)
  }
  return question && question.awaiting === null
    ? reading('dropped', replies.at(-1)?.body)
    : reading(null)
}
