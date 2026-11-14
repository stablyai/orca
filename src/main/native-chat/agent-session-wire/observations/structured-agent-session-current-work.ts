import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { StructuredAgentSessionObservedWork } from './structured-agent-session-observed-work'

export { StructuredAgentSessionObservedWork as StructuredAgentSessionCurrentWork }

/** The reader selects current work and returns its finished policy answer. */
export async function contextStructuredAgentSessionCurrentWork(ctx: {
  journal: AgentSessionJournal
  readWork?: JournalWorkReader
}): Promise<StructuredAgentSessionObservedWork> {
  if (!ctx.readWork) {
    throw new Error('current-work reader was not bound to this operation')
  }
  const { state } = await ctx.readWork({ kind: 'state' })
  return new StructuredAgentSessionObservedWork(ctx.journal, state, ctx.journal.cursor())
}
