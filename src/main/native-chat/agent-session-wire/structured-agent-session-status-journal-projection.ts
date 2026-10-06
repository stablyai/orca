// The status feed's per-journal projection, cached per commit: what a session's journal says its
// row is, and the user's newest send the provider accepted.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  sequence: number
  fence: number | undefined
  /** The Stop marks' settle revision: a settle edge writes no row, so it is a key of its own. */
  stopRevision: number
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  /** A person's Stop is still ending the work it stopped (`structuredAgentSessionStopping`). */
  stopping: boolean
}

export class StructuredAgentSessionJournalProjections {
  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  read(
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null
  ): StructuredAgentSessionJournalProjection {
    const cursor = journal.cursor()
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
    const fence = record?.lease.runtimeFence
    const stopRevision = journal.stopMarks.revision()
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.sequence !== cursor.sequence ||
      projection.fence !== fence ||
      projection.stopRevision !== stopRevision
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const snapshot = journal.snapshot()
      projection = {
        ...cursor,
        fence,
        stopRevision,
        state: projectStructuredAgentSessionStatusState(
          snapshot.items,
          snapshot.submissions,
          fence
        ),
        acceptedSendKey: newestAcceptedSendKey(cursor.epoch, snapshot.submissions),
        stopping: structuredAgentSessionStopping(journal, snapshot.items, snapshot.submissions)
      }
      this.byJournal.set(journal, projection)
    }
    return projection
  }
}
