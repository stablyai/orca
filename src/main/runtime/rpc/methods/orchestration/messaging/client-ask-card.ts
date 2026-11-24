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

// The conversation a question or handoff this Orca's agent sent a paired computer went out on, and
// the thread it was sent in (its own id unless it named one). One seek on the client-ask index.
const ISSUED_SQL = `SELECT i.dispatch_id, json_extract(i.payload, '$.threadId') AS thread_id
  FROM federation_relay_items i
  JOIN peer_mail_conversations c ON c.conversation_id = i.dispatch_id
  WHERE i.message_id = ? AND i.kind = 'client_ask' AND i.direction = 'to_worker'
    AND json_extract(i.payload, '$.type') IN ('question', 'handoff')
    AND c.role = 'home' AND c.environment_id LIKE '${CLIENT_ENVIRONMENT_PREFIX}%'`

// The ask's thread as that conversation brought it back, and mail on it that came over no
// conversation (this Orca's own notices among it). Mail another conversation brought is not it.
const REPLIES_SQL = `SELECT m.id, m.body, m.payload, p.conversation_id,
    CAST(strftime('%s', m.created_at) AS INTEGER) AS sent_at FROM messages m
  LEFT JOIN peer_mail_messages p ON p.message_id = m.id
  WHERE m.thread_id = ?1 AND (p.conversation_id = ?2 OR p.conversation_id IS NULL)
  ORDER BY m.rowid`

// When another ask this Orca sent that computer on the same conversation first shared the thread
// this ask opened, to the second (both stores keep seconds): a seek on the client-ask thread index.
const SHARED_SINCE_SQL = `SELECT MIN(CAST(strftime('%s', created_at) AS INTEGER)) AS since
  FROM federation_relay_items
  WHERE kind = 'client_ask' AND dispatch_id = ?1 AND json_extract(payload, '$.threadId') = ?2
    AND direction = 'to_worker' AND message_id <> ?2`

const DECLINED = '_declined'

/** The ask a returned reply names: the one it declines or answers; null for a plain reply. */
function namedAsk(reply: { id: string; payload: string | null }): string | null {
  if (reply.id.endsWith(DECLINED)) {
    return reply.id.slice(0, -DECLINED.length)
  }
  try {
    const payload: unknown = reply.payload ? JSON.parse(reply.payload) : null
    return typeof payload === 'object' &&
      payload !== null &&
      'requestId' in payload &&
      typeof payload.requestId === 'string'
      ? payload.requestId
      : null
  } catch {
    return null
  }
}

/** How an ask to a paired computer's agent stands here: declined on that computer's notice, answered
 *  by its agent's answer, or not answered when its question settled without one (this Orca's unpair
 *  or re-pair notice for it, shown as the answer is). A handoff, which awaits no answer, takes its
 *  first reply from that computer. Only a question or handoff this Orca sent reads as one, from its
 *  own conversation. On a thread other mail shares, only what names this ask counts: its decline,
 *  an answer to it, or the notice for it. */
export function readClientAskOutcome(
  db: OrchestrationDb,
  messageId: string
): BotRequestCardReading {
  const issued = db.db.prepare(ISSUED_SQL).get(messageId)
  if (!issued) {
    return { outcome: null, answer: null, mailIds: [], chatId: null }
  }
  const conversationId = String(issued.dispatch_id)
  const ownThread = typeof issued.thread_id !== 'string' || issued.thread_id === messageId
  // A plain reply in the thread this ask opened is its own while no later ask shares that thread,
  // and after, only when it came back in an earlier second than that ask went out: a reply of the
  // same second or later could answer either, so only one that names this ask is.
  const sharedSince = ownThread
    ? db.db.prepare(SHARED_SINCE_SQL).get(conversationId, messageId)?.since
    : undefined
  const plainIsOwn = (sentAt: number) =>
    ownThread && (typeof sharedSince !== 'number' || sentAt < sharedSince)
  const question = db.db
    .prepare('SELECT awaiting FROM peer_questions_out WHERE message_id = ? AND conversation_id = ?')
    .get(messageId, conversationId)
  const names = (reply: { id: string; payload: string | null }) =>
    reply.id === `${messageId}_declined` || isBotAnswer(reply, messageId)
  const replies = db.db
    .prepare(REPLIES_SQL)
    .all(ownThread ? messageId : String(issued.thread_id), conversationId)
    .map((row) => ({
      id: String(row.id),
      body: String(row.body),
      payload: typeof row.payload === 'string' ? row.payload : null,
      fromComputer: row.conversation_id !== null,
      sentAt: Number(row.sent_at)
    }))
    .filter((reply) =>
      reply.fromComputer
        ? names(reply) || (plainIsOwn(reply.sentAt) && namedAsk(reply) === null)
        : // tellUnpairedPeerQuestions names the question it settles.
          reply.body.includes(`Your question ${messageId} there will not be answered`)
    )
  // Only that computer answers or declines; a notice of this Orca's only settles a question.
  const returned = replies.filter((reply) => reply.fromComputer)
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
