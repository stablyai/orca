import {
  latestNativeChatUsageLimitCut,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  readUsageLimitContinueChain,
  usageLimitContinueIdentity,
  type HostUsageLimitCut,
  type UsageLimitContinueChainRead
} from '../recovery/structured-agent-session-usage-limit-chain'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../../shared/agent-session/structured-agent-session-command-entry'

import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { projectStructuredAgentSessionStatusState } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
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
  usageLimitCut: HostUsageLimitCut | null
  state: StructuredAgentSessionStatusState
  acceptedSendKey: string
  firstInputSubmissionKey: string | null
  submissionCount: number
  stopping: boolean
}

/** Everything a chain read could have seen change: the turn rows it looked up and the join evidence
 *  of every submission from the oldest it examined. Rows before the cut are otherwise fixed. */
function usageLimitChainKey(
  journal: AgentSessionJournal,
  snapshot: ReturnType<AgentSessionJournal['statusRead']>,
  cut: NativeChatUsageLimitCut,
  read: Omit<UsageLimitContinueChainRead, 'chain'>
): string {
  return JSON.stringify([
    usageLimitContinueIdentity(cut),
    read.turnsRead.map((itemId) => journal.item(itemId)?.revision),
    snapshot.submissions.length,
    snapshot.submissions
      .slice(read.submissionsFrom)
      .map((entry) => [entry.clientMessageId, entry.dispatchState, entry.providerItemId])
  ])
}

/** A rebuild whose chain inputs are unchanged reuses the count instead of walking the journal again. */
function usageLimitCutWithChain(
  journal: AgentSessionJournal,
  snapshot: ReturnType<AgentSessionJournal['statusRead']>,
  cut: NativeChatUsageLimitCut | null,
  previous: HostUsageLimitCut | null | undefined
): HostUsageLimitCut | null {
  if (!cut) {
    return null
  }
  const reused = previous?.chainRead
  if (reused && usageLimitChainKey(journal, snapshot, cut, reused) === reused.key) {
    return { ...cut, chain: previous.chain, chainRead: reused }
  }
  const read = readUsageLimitContinueChain(snapshot.items, snapshot.submissions, cut)
  return {
    ...cut,
    chain: read.chain,
    chainRead: { ...read, key: usageLimitChainKey(journal, snapshot, cut, read) }
  }
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
        usageLimitCut: usageLimitCutWithChain(
          journal,
          snapshot,
          latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions, journal.itemBody),
          sameContext?.usageLimitCut
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
