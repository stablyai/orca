import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { JournalDomainHistoryWork } from '../../agent-session-journal/journal-domain-history-page'
import type { JournalSqlWorkResult } from '../../agent-session-journal/journal-work-read'
import { StructuredAgentSessionObservedWork } from './structured-agent-session-observed-work'
import { captureStructuredAgentSessionWorkAuthority } from './structured-agent-session-work-authority'
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'
import {
  StructuredAgentSessionJournalProjections,
  type StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'

type Observed = (projection: StructuredAgentSessionJournalProjection) => void

/** Rows and current work from one reader snapshot, validated against live authority once; null
 *  when that authority changed during the read. */
export type StructuredAgentSessionWorkFrameReader = <T>(
  sessionId: string,
  journal: SqlAgentSessionJournal,
  rows: (work: JournalDomainHistoryWork | undefined) => Promise<{
    value: T
    work?: JournalSqlWorkResult
  }>
) => Promise<{
  work: StructuredAgentSessionObservedWork | null
  value: T
  /** Whether live authority, the owning handle and the adopted cursor still match the frame. */
  current: () => boolean
} | null>

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

  const capture = (sessionId: string, journal: SqlAgentSessionJournal) => () =>
    captureStructuredAgentSessionWorkAuthority(journal, sessionId, deps, {
      cursor: journal.cursor(),
      revision: journal.stopMarks.revision(),
      latest: null
    })

  const observedWork = (journal: SqlAgentSessionJournal, answer: JournalSqlWorkResult | null) => {
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

  const work = async (sessionId: string, journal: SqlAgentSessionJournal) =>
    observedWork(journal, await projections.readWorkSql(journal, capture(sessionId, journal)))

  const workFrame: StructuredAgentSessionWorkFrameReader = async (sessionId, journal, rows) => {
    const replaced = () => {
      const owner = deps.sessions.get(sessionId)?.journal
      return owner !== undefined && owner !== journal
    }
    if (replaced()) {
      return null
    }
    const frame = await projections.captureWorkFrame(journal, capture(sessionId, journal), rows)
    return frame && !replaced()
      ? {
          work: observedWork(journal, frame.answer),
          value: frame.value,
          current: () => frame.current() && !replaced()
        }
      : null
  }

  return Object.assign(read, { work, workFrame })
}
