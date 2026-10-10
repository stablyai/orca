// A Stop saved, then unable to confirm it took effect, says so on the turn it is about: its answer
// is its receipt, so this row is how the chat learns the cancellation was not confirmed.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { structuredAgentSessionNamedTurnScope } from './structured-agent-session-turn-stop-notes'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

/** Keyed as the Stop's own note (`stopKey`: its turn, else its operation), so it replaces whatever
 *  that note said. Bookkeeping: a write that fails is logged. */
export async function noteStructuredAgentSessionStopUnconfirmed(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'logger' | 'sessionId'>,
  stop: { turnId: string | null; operationId: string },
  error: unknown
): Promise<void> {
  ctx.logger.warn('a saved Stop failed to take effect', {
    scope: 'stop-unconfirmed',
    sessionId: ctx.sessionId,
    error
  })
  const note = agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), {
    surface: 'row'
  })
  await ctx.journal
    .appendItem(
      structuredAgentSessionStopNoteIdentity(stop.turnId ?? stop.operationId),
      { kind: 'status', ...note },
      {
        fence: ctx.fence,
        turnScope:
          (stop.turnId !== null
            ? structuredAgentSessionNamedTurnScope(ctx.journal, stop.turnId)
            : null) ?? ctx.journal.liveTurnScope()
      }
    )
    .catch((noteError: unknown) =>
      ctx.logger.warn("writing a failed Stop's note failed", {
        scope: 'stop-unconfirmed',
        sessionId: ctx.sessionId,
        error: noteError
      })
    )
}
