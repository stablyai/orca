import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'
import { structuredAgentSessionStoppingSteps } from './structured-agent-session-stopping'
import { newestAcceptedSendKeySteps } from './structured-agent-session-status-child-work'
import { projectStructuredAgentSessionStatusStateSteps } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { latestNativeChatUsageLimitCutSteps } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  finishJournalSteps,
  finishJournalStepsAsync,
  sortJournalSteps
} from '../agent-session-journal/journal-reconstruction-steps'
import type { NativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/agent-session/structured-agent-session-command-entry'

import type { AgentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type { projectStructuredAgentSessionStatusState } from '../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import {
  structuredAgentSessionCurrentWork,
  type StructuredAgentSessionWorkEvidence
} from './structured-agent-session-current-work'

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
}

export class StructuredAgentSessionJournalProjections {
  // Key by journal lifetime; task-progress frames must not rescan unchanged conversations.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    {
      projection: StructuredAgentSessionJournalProjection
      itemIds: ReadonlySet<string>
      workKey: string
    }
  >()

  constructor(
    private readonly replacedRuntime?: (
      sessionId: string
    ) => StructuredAgentSessionWorkEvidence['replaced']
  ) {}

  /** Creation cards cannot change status unless they replace an item the projection read. */
  advance(journal: AgentSessionJournal, rows?: readonly JournalRow[]): void {
    const cached = this.byJournal.get(journal)
    if (!cached || !rows?.length) {
      return
    }
    const cursor = journal.cursor()
    if (
      cached.projection.epoch === cursor.epoch &&
      rows.at(-1)?.seq === cursor.sequence &&
      rows.every(
        (row, index) =>
          row.epoch === cursor.epoch &&
          row.seq === cached.projection.sequence + index + 1 &&
          row.kind === 'item' &&
          (row.body.kind === 'agent-start' || row.body.kind === 'agent-handoff') &&
          !Object.hasOwn(row, 'echoOf') &&
          !cached.itemIds.has(journal.canonicalItemId(row.itemId))
      )
    ) {
      this.byJournal.set(journal, {
        ...cached,
        projection: { ...cached.projection, sequence: cursor.sequence }
      })
    }
  }

  installed(journal: AgentSessionJournal): StructuredAgentSessionJournalProjection | null {
    return this.byJournal.get(journal)?.projection ?? null
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
    return finishJournalSteps(this.readSteps(journal, record, seen))
  }
  async prepare(
    deps: StructuredAgentSessionStatusFeedDeps,
    id: string,
    journal: AgentSessionJournal
  ): Promise<void> {
    for (;;) {
      const session = deps.sessions.get(id)
      if (session?.journal !== journal) {
        return
      }
      const record = deps.getConversation(id)
      const before = this.evidence(journal, record, session)
      const previous = this.byJournal.get(journal)
      const ended = session.lastEndedChild
      const child = session.child
      let installed = true
      const current = () => {
        const next = this.evidence(journal, deps.getConversation(id), session)
        installed =
          deps.sessions.get(id) === session &&
          session.journal === journal &&
          session.lastEndedChild === ended &&
          session.child === child &&
          this.byJournal.get(journal) === previous &&
          before.cursor.epoch === next.cursor.epoch &&
          before.cursor.sequence === next.cursor.sequence &&
          before.contextId === next.contextId &&
          before.fence === next.fence &&
          before.work.viewKey() === next.work.viewKey() &&
          before.work.liveFence === next.work.liveFence &&
          before.work.revision === next.work.revision &&
          before.stopRevision === next.stopRevision
        return installed
      }
      await finishJournalStepsAsync(this.readSteps(journal, record, session, current))
      if (installed) {
        return
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  private *readSteps(
    journal: AgentSessionJournal,
    record: AgentSessionConversationView | null,
    seen?: {
      lastEndedChild?: StructuredAgentSessionWorkEvidence['ended']
      operationalRevision?: number
      child?: StructuredAgentSessionWorkEvidence['child']
    },
    current?: () => boolean
  ): Generator<void, StructuredAgentSessionJournalProjection> {
    const { cursor, contextId, fence, work, stopRevision } = this.evidence(journal, record, seen)
    const cached = this.byJournal.get(journal)
    let projection = cached?.projection
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.contextId !== contextId ||
      projection.sequence !== cursor.sequence ||
      projection.fence !== fence ||
      projection.liveFence !== work.liveFence ||
      projection.workRevision !== work.revision ||
      projection.stopRevision !== stopRevision ||
      cached?.workKey !== work.viewKey()
    ) {
      // Journal sequence captures sends; lease/live-work/Stop keys capture row-free changes.
      const snapshot = current ? yield* journal.statusReadSteps() : journal.statusRead()
      yield* work.actionablePromptSteps(current)
      const sameContext =
        projection?.epoch === cursor.epoch && projection.contextId === contextId
          ? projection
          : undefined
      let firstInputSubmissionKey = sameContext?.firstInputSubmissionKey ?? null
      const floor = sameContext ? 0 : (journal.context.floor()?.sequence ?? 0)
      const start = sameContext?.submissionCount ?? 0
      const candidates: typeof snapshot.submissions = []
      if (!firstInputSubmissionKey) {
        for (const entry of snapshot.submissions) {
          if (journal.inputOrder.inputOrdinal(entry.clientMessageId) >= start) {
            candidates.push(entry)
          }
          yield
        }
      }
      const submissions = yield* sortJournalSteps(
        candidates,
        (a, b) =>
          journal.inputOrder.inputOrdinal(a.clientMessageId) -
          journal.inputOrder.inputOrdinal(b.clientMessageId)
      )
      for (const submission of submissions) {
        yield
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
      const itemIds = new Set<string>()
      for (const item of snapshot.items) {
        itemIds.add(item.itemId)
        yield
      }
      projection = {
        ...cursor,
        contextId,
        usageLimitCut: yield* latestNativeChatUsageLimitCutSteps(
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
          yield* projectStructuredAgentSessionStatusStateSteps(
            snapshot.items,
            snapshot.submissions,
            fence,
            work.scope
          ),
          work.diedTurn()
        ),
        acceptedSendKey: yield* newestAcceptedSendKeySteps(cursor.epoch, snapshot.submissions),
        stopping: yield* structuredAgentSessionStoppingSteps(
          journal,
          snapshot.items,
          snapshot.submissions,
          work.scope
        )
      }
      if (!current || current()) {
        this.byJournal.set(journal, { projection, itemIds, workKey: work.viewKey() })
      }
    }
    return projection
  }
  private evidence(
    journal: AgentSessionJournal,
    record: AgentSessionConversationView | null,
    seen: Parameters<StructuredAgentSessionJournalProjections['read']>[2]
  ) {
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
    return { cursor, contextId, fence, work, stopRevision }
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
