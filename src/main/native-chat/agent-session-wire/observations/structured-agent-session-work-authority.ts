import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { JournalWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLatestStop } from '../../agent-session-journal/context-epochs/journal-stop-turn-end'
import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
import { structuredAgentSessionHandoverAuthority } from '../delivery/structured-agent-session-handing-over'
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'

/** Capture live owners synchronously; the asynchronous Stop answer is pinned to its read identity. */
export function captureStructuredAgentSessionWorkAuthority(
  journal: SqlAgentSessionJournal,
  sessionId: string,
  deps: Pick<
    StructuredAgentSessionStatusFeedDeps,
    'sessions' | 'getConversation' | 'replacedRuntime'
  >,
  stop: { cursor: AgentJournalCursor; revision: number; latest: JournalLatestStop | null }
): { authority: JournalWorkAuthority; contextId: string | null } | null {
  const session = deps.sessions.get(sessionId)
  if (
    session?.journal !== journal ||
    journal.isClosed ||
    stop.revision !== journal.stopMarks.revision() ||
    !sameJournalCursor(stop.cursor, journal.cursor())
  ) {
    return null
  }
  const record = deps.getConversation(sessionId)
  const child = session.child
  const heldSends = child?.heldSends?.()
  return {
    contextId: record?.providerContextBoundary?.operationId ?? null,
    authority: {
      handle: journal.observationHandle(),
      record,
      ended: session.lastEndedChild,
      replaced: deps.replacedRuntime?.(sessionId),
      child:
        child === undefined || child === null
          ? child
          : { fence: child.fence, heldSends: heldSends && [...heldSends] },
      ...structuredAgentSessionHandoverAuthority(journal),
      openedThrough: journal.openingCursor(),
      reopenFloor: journal.reopenFloor(),
      operationalRevision: session.operationalRevision ?? 0,
      stopRevision: stop.revision,
      stop: stop.latest
    }
  }
}
