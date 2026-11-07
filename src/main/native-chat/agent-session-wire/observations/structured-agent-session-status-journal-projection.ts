import { copyJournalWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type {
  JournalWorkAuthority,
  JournalObserverResult
} from '../../agent-session-journal/journal-observer-read'
import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
import {
  latestNativeChatUsageLimitCut,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../../shared/agent-session/structured-agent-session-command-entry'

import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { projectStructuredAgentSessionStatusState } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { withStructuredAgentSessionDiedTurnVerdict as withDiedTurnVerdict } from './structured-agent-session-work-policy'
import { structuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

import type { StructuredAgentSessionWorkEvidence } from './structured-agent-session-work-evidence'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'
import { structuredAgentSessionStopping } from '../termination/structured-agent-session-stopping'

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
  usageLimitCut: NativeChatUsageLimitCut | null
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  stopping: boolean
  authority?: JournalWorkAuthority
  work?: JournalObserverResult['work']
}

export class StructuredAgentSessionJournalProjections {
  // Key by journal lifetime; task-progress frames must not rescan unchanged conversations.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal | SqlAgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  constructor(
    private readonly replacedRuntime?: (
      sessionId: string
    ) => StructuredAgentSessionWorkEvidence['replaced']
  ) {}

  /** Discard an invalidated asynchronous answer before touching the existing publication cache. */
  async readSql(
    journal: SqlAgentSessionJournal,
    capture: () => { authority: JournalWorkAuthority; contextId: string | null },
    invalidated: () => void
  ): Promise<StructuredAgentSessionJournalProjection | null> {
    const captured = capture()
    const contextId = captured.contextId
    const authority = copyJournalWorkAuthority(captured.authority)
    const signature = JSON.stringify(authority)
    const cursor = journal.cursor()
    const prior = this.byJournal.get(journal)
    if (
      !journal.isClosed &&
      prior?.authority &&
      sameJournalCursor(prior, cursor) &&
      prior.contextId === contextId &&
      JSON.stringify(prior.authority) === signature
    ) {
      return prior
    }
    const sameContext =
      prior?.epoch === cursor.epoch && prior.contextId === contextId ? prior : undefined
    const result = await journal.reads.observer({
      authority,
      start: sameContext?.submissionCount ?? 0,
      floor: sameContext ? 0 : undefined,
      firstInputSubmissionKey: sameContext?.firstInputSubmissionKey ?? null
    })
    const current = capture()
    if (
      journal.isClosed ||
      !sameJournalCursor(result.cursor, journal.cursor()) ||
      !sameJournalCursor(result.physicalCursor, journal.physicalCursor()) ||
      authority.handle !== journal.observationHandle() ||
      !sameJournalCursor(authority.openedThrough, journal.openingCursor()) ||
      current.contextId !== contextId ||
      JSON.stringify(copyJournalWorkAuthority(current.authority)) !== signature ||
      JSON.stringify(result.authority) !== signature
    ) {
      invalidated()
      return null
    }
    const projection: StructuredAgentSessionJournalProjection = {
      ...result.cursor,
      contextId,
      fence: authority.record?.currentFence,
      liveFence: result.work.liveFence,
      workRevision: authority.operationalRevision,
      stopRevision: authority.stopRevision,
      usageLimitCut: result.usageLimitCut,
      state: result.state,
      ...result.indicators,
      authority,
      work: result.work
    }
    this.byJournal.set(journal, projection)
    return projection
  }

  read(
    journal: AgentSessionJournal,
    record: AgentSessionConversationView | null,
    seen?: {
      lastEndedChild?: StructuredAgentSessionWorkEvidence['ended']
      operationalRevision?: number
      child?: StructuredAgentSessionWorkEvidence['child']
    }
  ): StructuredAgentSessionJournalProjection {
    const cursor = journal.cursor()
    const contextId = record?.providerContextBoundary?.operationId ?? null
    const fence = record?.currentFence
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
      const snapshot = journal.statusRead()
      const sameContext =
        projection?.epoch === cursor.epoch && projection.contextId === contextId
          ? projection
          : undefined
      let firstInputSubmissionKey = sameContext?.firstInputSubmissionKey ?? null
      const floor = sameContext ? 0 : (journal.context.floor()?.sequence ?? 0)
      const start = sameContext?.submissionCount ?? 0
      const submissions = firstInputSubmissionKey
        ? []
        : snapshot.submissions
            .filter((entry) => journal.inputOrder.inputOrdinal(entry.clientMessageId) >= start)
            .sort(
              (a, b) =>
                journal.inputOrder.inputOrdinal(a.clientMessageId) -
                journal.inputOrder.inputOrdinal(b.clientMessageId)
            )
      for (const submission of submissions) {
        if (firstInputSubmissionKey) {
          break
        }
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
        usageLimitCut: latestNativeChatUsageLimitCut(
          snapshot.items,
          snapshot.submissions,
          journal.itemBody
        ),
        firstInputSubmissionKey,
        submissionCount: journal.inputOrder.inputCount(),
        fence,
        liveFence: work.liveFence,
        workRevision: work.revision,
        stopRevision,
        state: withDiedTurnVerdict(
          projectStructuredAgentSessionStatusState(
            snapshot.items,
            snapshot.submissions,
            fence,
            work.scope,
            snapshot.item
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
