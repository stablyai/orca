import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { captureStructuredAgentSessionWorkAuthority } from './structured-agent-session-work-authority'
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'
import {
  StructuredAgentSessionJournalProjections,
  type StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'

type Observed = (projection: StructuredAgentSessionJournalProjection) => void
type ProjectionRead =
  | StructuredAgentSessionJournalProjection
  | null
  | Promise<StructuredAgentSessionJournalProjection | null>

/** The existing per-handle cache binds the reader to its real live owners and publication path. */
export function createStructuredAgentSessionStatusReader(
  deps: StructuredAgentSessionStatusFeedDeps,
  invalidated: (sessionId: string) => void
) {
  const projections = new StructuredAgentSessionJournalProjections((id) =>
    deps.replacedRuntime?.(id)
  )

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

  function read(
    sessionId: string,
    journal: AgentSessionJournal,
    observed?: Observed,
    refresh?: () => void
  ): StructuredAgentSessionJournalProjection | null
  function read(
    sessionId: string,
    journal?: AgentSessionJournal | SqlAgentSessionJournal,
    observed?: Observed,
    refresh?: () => void
  ): ProjectionRead
  function read(
    sessionId: string,
    journal?: AgentSessionJournal | SqlAgentSessionJournal,
    observed?: Observed,
    refresh = () => invalidated(sessionId)
  ): ProjectionRead {
    const session = deps.sessions.get(sessionId)
    const source = journal ?? session?.journal
    if (!source) {
      return null
    }
    if (source instanceof SqlAgentSessionJournal) {
      return readSql(sessionId, source, refresh, observed)
    }
    const projection = projections.read(source, deps.getConversation(sessionId), session)
    observed?.(projection)
    return projection
  }

  return read
}
