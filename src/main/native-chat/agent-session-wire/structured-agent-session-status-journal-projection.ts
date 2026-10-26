import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/structured-agent-session-command-entry'

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  structuredAgentSessionCurrentWork,
  type StructuredAgentSessionWorkEvidence
} from './structured-agent-session-current-work'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { structuredAgentSessionStopping } from './structured-agent-session-stopping'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  contextId: string | null
  sequence: number
  fence: number | undefined
  /** Live authority may change without a journal row. */
  liveFence: number | null
  /** Include observed row-free/lease-free child endings in cache identity. */
  workRevision: number
  /** Stop settlement edges write no row and need an independent cache key. */
  stopRevision: number
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  stopping: boolean
}

export class StructuredAgentSessionJournalProjections {
  // Key by journal lifetime; task-progress frames must not rescan unchanged conversations.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  constructor(
    private readonly replacedRuntime?: (
      sessionId: string
    ) => StructuredAgentSessionWorkEvidence['replaced']
  ) {}

  read(
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null,
    seen?: {
      lastEndedChild?: StructuredAgentSessionWorkEvidence['ended']
      operationalRevision?: number
      child?: StructuredAgentSessionWorkEvidence['child']
    }
  ): StructuredAgentSessionJournalProjection {
    const cursor = journal.cursor()
    const contextId = record?.providerContextBoundary?.operationId ?? null
    const fence = record?.lease.runtimeFence
    const ended = seen?.lastEndedChild
    const work = structuredAgentSessionCurrentWork(journal, {
      record,
      replaced: record ? this.replacedRuntime?.(record.sessionId) : undefined,
      child: seen?.child ?? null,
      ...(ended ? { ended } : {}),
      revision: seen?.operationalRevision ?? 0
    })
    const stopRevision = journal.stopMarks.revision()
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.contextId !== contextId ||
      projection.sequence !== cursor.sequence ||
      projection.fence !== fence ||
      projection.liveFence !== work.liveFence ||
      projection.workRevision !== work.revision ||
      projection.stopRevision !== stopRevision
    ) {
      // Journal sequence captures sends; lease/live-work/Stop keys capture row-free changes.
      const snapshot = journal.snapshot()
      const sameContext =
        projection?.epoch === cursor.epoch && projection.contextId === contextId
          ? projection
          : undefined
      let firstInputSubmissionKey = sameContext?.firstInputSubmissionKey ?? null
      const start = sameContext?.submissionCount ?? 0
      const floor = sameContext ? 0 : (journal.context.floor()?.sequence ?? 0)
      const submissions =
        !firstInputSubmissionKey && snapshot.submissions.length !== start
          ? journal.submissions()
          : snapshot.submissions
      for (let index = start; !firstInputSubmissionKey && index < submissions.length; index++) {
        const submission = submissions[index]
        const item =
          journal.item(agentJournalSubmissionKey(submission.clientMessageId)) ??
          (submission.providerItemId ? journal.item(submission.providerItemId) : null)
        if (
          item &&
          item.sequence > floor &&
          item.body.kind === 'message' &&
          item.body.role === 'user' &&
          isRootAgentJournalItem(item) &&
          !isStructuredAgentSessionCommandEntry(item.body)
        ) {
          firstInputSubmissionKey = JSON.stringify([cursor.epoch, submission.clientMessageId])
        }
      }
      projection = {
        ...cursor,
        contextId,
        firstInputSubmissionKey,
        submissionCount: snapshot.submissions.length,
        fence,
        liveFence: work.liveFence,
        workRevision: work.revision,
        stopRevision,
        state: withDiedTurnVerdict(
          projectStructuredAgentSessionStatusState(
            snapshot.items,
            snapshot.submissions.map(work.publishedSubmission),
            fence,
            work.scope
          ),
          work.diedTurn()
        ),
        acceptedSendKey: newestAcceptedSendKey(cursor.epoch, snapshot.submissions),
        stopping: structuredAgentSessionStopping(
          journal,
          snapshot.items,
          snapshot.submissions,
          work.scope
        )
      }
      this.byJournal.set(journal, projection)
    }
    return projection
  }
}

/** Project proven child death immediately, before durable settlement can land. */
function withDiedTurnVerdict(
  state: StructuredAgentSessionStatusState,
  died: { turnId: string } | null
): StructuredAgentSessionStatusState {
  const request = state.latestRequest
  return died &&
    state.summary.status === 'idle' &&
    request?.kind === 'turn' &&
    request.id === died.turnId &&
    request.turnState === 'running'
    ? { ...state, summary: { ...state.summary, turnOutcome: 'interruption' } }
    : state
}
