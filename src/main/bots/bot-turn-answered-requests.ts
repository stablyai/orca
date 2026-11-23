import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import { botRequestIdsOf } from './bot-request-asker'

/** The bot requests a turn answered, as its provider recorded them (journalTurnAnsweredMessages):
 *  its opener and the sends it steered in, never one the host only scoped to it. A turn woken only
 *  by agent mail (a worker's report) works on the requests of the acting turn before it.
 *  `turnId`: the ended turn's id, or a failed request's item id. */
export async function botRequestsTurnAnswered(
  reads: Pick<JournalSqlReads, 'turnAttribution'>,
  turnId: string,
  isBotRequest: (messageId: string) => boolean,
  actingTurnRequests: () => Promise<string[]>
): Promise<string[]> {
  const { messages } = await reads.turnAttribution(turnId, Number.MAX_SAFE_INTEGER)
  const answered = messages ?? []
  const requests = answered.flatMap((item) => botRequestIdsOf(item.body, isBotRequest))
  if (requests.length > 0 || answered.some((item) => !isAgentMail(item.body))) {
    return requests
  }
  return await actingTurnRequests()
}

const isAgentMail = (body: AgentJournalItemBody): boolean =>
  body.kind === 'message' && body.from !== undefined
