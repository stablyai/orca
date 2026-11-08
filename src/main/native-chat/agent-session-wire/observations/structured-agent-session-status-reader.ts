import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { captureStructuredAgentSessionWorkAuthority } from './structured-agent-session-work-authority'
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'
import {
  StructuredAgentSessionJournalProjections,
  type StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'

type Observed = (projection: StructuredAgentSessionJournalProjection) => void
/** The existing per-handle cache binds the reader to its real live owners and publication path. */
export function createStructuredAgentSessionStatusReader(
  deps: StructuredAgentSessionStatusFeedDeps,
  invalidated: (sessionId: string) => void
) {
  const projections = new StructuredAgentSessionJournalProjections()

  async function readSql(
    sessionId: string,
    journal: SqlAgentSessionJournal,
    refresh: () => void,
    observed?: Observed
  ) {
    const cursor = journal.cursor()
    const revision = journal.stopMarks.revision()
    const latest = await journal.stopMarks.latest()
    return projections.readSql(
      journal,
      () =>
        captureStructuredAgentSessionWorkAuthority(journal, sessionId, deps, {
          cursor,
          revision,
          latest
        }),
      refresh,
      observed
    )
  }

  return async function read(
    sessionId: string,
    journal?: SqlAgentSessionJournal,
    observed?: Observed,
    refresh = () => invalidated(sessionId)
  ): Promise<StructuredAgentSessionJournalProjection | null> {
    const source = journal ?? deps.sessions.get(sessionId)?.journal
    return source ? readSql(sessionId, source, refresh, observed) : null
  }
}
