// A Stop saved, then unable to confirm it took effect, says so on the turn it is about: its answer
// is its receipt, so this row is how the chat learns the cancellation was not confirmed.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalStatusItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { structuredAgentSessionNamedTurnScope } from './structured-agent-session-turn-stop-notes'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

type StopNoteContext = Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'logger' | 'sessionId'>

/** Keyed as the Stop's own note (`stopKey`: its turn, else its operation), so it replaces whatever
 *  that note said. Bookkeeping: a write that fails is logged. */
export async function noteStructuredAgentSessionStopUnconfirmed(
  ctx: StopNoteContext & Pick<AgentSessionTurnContext, 'currentWork'>,
  stop: { turnId: string | null; operationId: string },
  error: unknown,
  turnScope?: AgentJournalTurnScope
): Promise<void> {
  ctx.logger.warn('a saved Stop failed to take effect', {
    scope: 'stop-unconfirmed',
    sessionId: ctx.sessionId,
    error
  })
  const note = agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), {
    surface: 'row'
  })
  await writeStructuredAgentSessionStopNote(
    ctx,
    stop.turnId ?? stop.operationId,
    { kind: 'status', ...note },
    turnScope ??
      (stop.turnId !== null
        ? structuredAgentSessionNamedTurnScope(ctx.journal, stop.turnId)
        : null) ??
      contextStructuredAgentSessionCurrentWork(ctx).turnScope()
  )
}

/** Writes a Stop's note under its key; what the Stop did stands whether or not the note lands. */
export async function writeStructuredAgentSessionStopNote(
  ctx: StopNoteContext,
  stopKey: string,
  note: AgentJournalStatusItem,
  turnScope: AgentJournalTurnScope
): Promise<void> {
  await ctx.journal
    .appendItem(structuredAgentSessionStopNoteIdentity(stopKey), note, {
      fence: ctx.fence,
      turnScope
    })
    .catch((noteError: unknown) =>
      ctx.logger.warn("writing a Stop's note failed", {
        scope: 'stop-note',
        sessionId: ctx.sessionId,
        error: noteError
      })
    )
}
