// Key Stop notes by captured turn so repeated Stops revise one row, even after the turn ends.

import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { structuredAgentSessionStopNoteIdentity } from '../operations/structured-agent-session-command-turn'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'

export { STOP_NOTE_CANCELLATION_REQUESTED } from '../../../../shared/agent-session/view/structured-agent-session-stop-note-identity'

export function structuredAgentSessionStoppedTurnId(
  work: Pick<StructuredAgentSessionCurrentWork, 'activeTurnId'>,
  namedTurnId: string | undefined
): string | null {
  return namedTurnId ?? work.activeTurnId()
}

export function structuredAgentSessionStopNamesTurnNotLive(
  namedTurnId: string | undefined,
  liveTurnId: string | null
): boolean {
  return namedTurnId !== undefined && namedTurnId !== liveTurnId
}

/** A known non-live turn is ended, including one removed by rewind; unknown turns may still open. */
export async function structuredAgentSessionStopNamesEndedTurn(
  journal: Pick<AgentSessionJournal, 'reads'>,
  work: Pick<StructuredAgentSessionCurrentWork, 'activeTurnId' | 'working'>,
  namedTurnId: string | undefined
): Promise<boolean> {
  const live = work.activeTurnId()
  if (namedTurnId === undefined || namedTurnId === live) {
    return false
  }
  if (live !== null || !work.working()) {
    return true
  }
  const turn = await journal.reads.namedTurn(namedTurnId)
  return turn.removed || turn.scope !== null
}

export async function structuredAgentSessionNamedTurnScope(
  journal: Pick<AgentSessionJournal, 'reads'>,
  turnId: string
): Promise<Extract<AgentJournalTurnScope, { kind: 'turn' }> | null> {
  return (await journal.reads.namedTurn(turnId)).scope
}

export function writeStructuredAgentSessionStopNote(
  ctx: {
    journal: AgentSessionJournal
    fence: number
    logger: StructuredAgentSessionLogger
    sessionId: string
  },
  input: {
    identity: ReturnType<typeof structuredAgentSessionStopNoteIdentity>
    body: AgentJournalStatusItem
    stoppedTurn?: string
    fallbackScope: AgentJournalTurnScope
  }
): Promise<void> {
  return ctx.journal
    .appendItem(input.identity, input.body, {
      fence: ctx.fence,
      stoppedTurnId: input.stoppedTurn,
      turnScope: input.fallbackScope
    })
    .then(() => undefined)
    .catch((error: unknown) =>
      ctx.logger.warn('writing the Stop note failed', {
        scope: 'chat-stop-note',
        sessionId: ctx.sessionId,
        error
      })
    )
}
