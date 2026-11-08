import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { selectableStructuredSubmission } from './structured-agent-session-input-selection'

/** Opening obligations and raw root-turn evidence share the worker's read snapshot. */
export async function structuredAgentSessionSendOpeningTurnInJournal(
  readWork: JournalWorkReader,
  fence: number
): Promise<boolean> {
  return (await readWork({ kind: 'opening-send', fence })).opening
}

/** Oldest pending send, unless an earlier send still opens its turn; settlement wakes delivery. */
export async function structuredAgentSessionNextHandover(
  session: { journal: SqlAgentSessionJournal },
  fence: number,
  readWork: JournalWorkReader,
  work?: StructuredAgentSessionObservedWork | null
) {
  return (await structuredAgentSessionSendOpeningTurnInJournal(readWork, fence))
    ? undefined
    : selectableStructuredSubmission(session.journal, work ?? null)
}
