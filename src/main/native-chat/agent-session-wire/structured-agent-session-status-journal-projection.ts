import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import {
  isBackgroundTaskBlock,
  isSubagentBlock,
  isSubagentGroupBlock
} from '../../../shared/native-chat-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/structured-agent-session-command-entry'
// The status feed's per-journal projection, cached per commit: what a session's journal says its
// row is, and the user's newest send the provider accepted.

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
  sequence: number
  fence: number | undefined
  /** The live generation's fence (`structuredAgentSessionLiveFence`): an exit this host saw, or a
   *  release, changes what is current without a journal row. */
  liveFence: number | null
  /** `StructuredAgentSessionCurrentWork.revision`: what this host saw end with no row or lease
   *  write still changes the row. */
  workRevision: number
  workView: string
  unobservedChildren: ReadonlyMap<string, string | undefined>
  /** The Stop marks' settle revision: a settle edge writes no row, so it is a key of its own. */
  stopRevision: number
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  /** A person's Stop is still ending the work it stopped (`structuredAgentSessionStopping`). */
  stopping: boolean
}

export class StructuredAgentSessionJournalProjections {
  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  /** `AgentSessionRecordStore.replacedRuntime`, which ends what a replaced runtime held. */
  constructor(
    private readonly replacedRuntime?: (
      sessionId: string
    ) => StructuredAgentSessionWorkEvidence['replaced']
  ) {}

  read(
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null,
    /** What this host saw end (`StructuredAgentSessionHostSession`). */
    seen?: {
      lastEndedChild?: StructuredAgentSessionWorkEvidence['ended']
      operationalRevision?: number
      child?: StructuredAgentSessionWorkEvidence['child']
    }
  ): StructuredAgentSessionJournalProjection {
    const cursor = journal.cursor()
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
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
      projection.sequence !== cursor.sequence ||
      projection.fence !== fence ||
      projection.liveFence !== work.liveFence ||
      projection.workRevision !== work.revision ||
      projection.workView !== work.viewKey() ||
      projection.stopRevision !== stopRevision
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const snapshot = work.formSnapshot(journal.snapshot())
      let firstInputSubmissionKey =
        projection?.epoch === cursor.epoch ? projection.firstInputSubmissionKey : null
      const start = projection?.epoch === cursor.epoch ? projection.submissionCount : 0
      const submissions =
        !firstInputSubmissionKey && snapshot.submissions.length !== start
          ? journal.submissions()
          : snapshot.submissions
      // New submissions are visited once; streamed output cannot rescan command history.
      for (let index = start; !firstInputSubmissionKey && index < submissions.length; index++) {
        const submission = submissions[index]
        const item =
          journal.item(agentJournalSubmissionKey(submission.clientMessageId)) ??
          (submission.providerItemId ? journal.item(submission.providerItemId) : null)
        if (
          item?.body.kind === 'message' &&
          item.body.role === 'user' &&
          isRootAgentJournalItem(item) &&
          !isStructuredAgentSessionCommandEntry(item.body)
        ) {
          firstInputSubmissionKey = JSON.stringify([cursor.epoch, submission.clientMessageId])
        }
      }
      projection = {
        ...cursor,
        firstInputSubmissionKey,
        submissionCount: snapshot.submissions.length,
        fence,
        liveFence: work.liveFence,
        workRevision: work.revision,
        workView: work.viewKey(),
        unobservedChildren: unobservedJournalChildren(snapshot, journal, work.observedExecution),
        stopRevision,
        // The host's projection of current work: an ended generation's is not Working.
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

/** A turn whose generation died on its own reads as its settlement writes it, interrupted, before
 *  that lands: never a finish with no verdict (`StructuredAgentSessionCurrentWork.diedTurn`). */
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

/** Unobserved journal owners supply display state without changing reported record outcomes. */
function unobservedJournalChildren(
  snapshot: AgentJournalSnapshot,
  journal: Pick<AgentSessionJournal, 'itemFence'>,
  observed: number | null | undefined
): Map<string, string | undefined> {
  const children = new Map<string, string | undefined>()
  for (const item of snapshot.items) {
    if (item.body.kind !== 'message') {
      continue
    }
    const owner = journal.itemFence(item.itemId)
    const unseen = observed !== undefined && owner !== undefined && owner !== observed
    const keep = (key: string, state: string, run?: string): void => {
      if (unseen && state === 'unverifiable') {
        children.set(key, run)
      } else {
        children.delete(key)
      }
    }
    for (const block of item.body.blocks) {
      if (isSubagentBlock(block)) {
        keep(`agent:${block.id}`, block.state, block.run)
      } else if (isBackgroundTaskBlock(block)) {
        keep(`${block.kind}:${block.taskId}`, block.state)
      } else if (isSubagentGroupBlock(block)) {
        for (const child of block.agents) {
          keep(`agent:${child.id}`, child.state)
        }
      }
    }
  }
  return children
}

/** Keep reported outcomes intact while an unobserved live owner reads as unverifiable. */
export function observedStatusChildWork(
  view: AgentChildWorkView,
  unseen: ReadonlyMap<string, string | undefined>
): AgentChildWorkView {
  const key = `${view.kind}:${view.providerId}`
  const run = unseen.get(key)
  return view.membership === 'live' &&
    unseen.has(key) &&
    (run === undefined || run === view.invocation.invocationId)
    ? { ...view, state: 'unverifiable' }
    : view
}
