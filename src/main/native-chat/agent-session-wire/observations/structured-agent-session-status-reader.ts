import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { StructuredAgentSessionObservedWork } from './structured-agent-session-observed-work'
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
    const saved = projections.savedStop(
      journal,
      deps.getConversation(sessionId)?.providerContextBoundary?.operationId ?? null
    )
    const latest = saved ? saved.value : await journal.stopMarks.latest()
    return projections.readSql(
      journal,
      () =>
        captureStructuredAgentSessionWorkAuthority(journal, sessionId, deps, {
          cursor,
          revision,
          latest: journal.stopMarks.withCurrentSettlement(latest)
        }),
      refresh,
      observed
    )
  }

  async function read(
    sessionId: string,
    journal?: SqlAgentSessionJournal,
    observed?: Observed,
    refresh = () => invalidated(sessionId)
  ): Promise<StructuredAgentSessionJournalProjection | null> {
    const source = journal ?? deps.sessions.get(sessionId)?.journal
    return source ? readSql(sessionId, source, refresh, observed) : null
  }

  const work = async (sessionId: string, journal: SqlAgentSessionJournal) => {
    const answer = await projections.readWorkSql(journal, () =>
      captureStructuredAgentSessionWorkAuthority(journal, sessionId, deps, {
        cursor: journal.cursor(),
        revision: journal.stopMarks.revision(),
        latest: null
      })
    )
    if (!answer) {
      return null
    }
    if (answer.result.kind !== 'state') {
      throw new Error('journal work reader returned another answer')
    }
    return new StructuredAgentSessionObservedWork(
      journal,
      answer.result.state,
      answer.cursor,
      answer
    )
  }

  return Object.assign(read, { work })
}
