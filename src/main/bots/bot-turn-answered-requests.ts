import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import { botRequestIdsOf } from './bot-request-asker'
import { readNewestBotActingTurn } from './bot-acting-turn-read'

/** The bot requests a turn answered, as its provider recorded them (journalTurnAnsweredMessages):
 *  its opener and the sends it steered in, never one the host only scoped to it. None when the
 *  turn's rows can't be read. With `reportFallback`, a turn that answered only agent mail (woken by
 *  a worker's report) works on the requests of the acting turn that ended before it.
 *  `turnId`: the ended turn's id, or a failed request's item id. */
export async function botRequestsTurnAnswered(
  reads: Pick<JournalSqlReads, 'turnAttribution' | 'operationWindow'>,
  turnId: string,
  isBotRequest: (messageId: string) => boolean,
  { reportFallback }: { reportFallback: boolean }
): Promise<string[]> {
  const { messages } = await reads.turnAttribution(turnId, Number.MAX_SAFE_INTEGER)
  if (!messages?.length) {
    return []
  }
  const requests = messages.flatMap((item) => botRequestIdsOf(item.body, isBotRequest))
  if (requests.length > 0 || !reportFallback || messages.some((item) => !isAgentMail(item.body))) {
    return requests
  }
  // Only which requests it took matters here, not whom they act for.
  const acting = await readNewestBotActingTurn(
    reads,
    {
      isBotRequest,
      botRequestActsFor: () => null,
      conversationActsFor: [],
      conversationWorkspaceId: null
    },
    turnId
  )
  return acting.requestIds
}

const isAgentMail = (body: AgentJournalItemBody): boolean =>
  body.kind === 'message' && body.from !== undefined
