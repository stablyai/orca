import { providerTimelineExecutionItems } from '../../agent-session-timeline/provider-timeline-history'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../../shared/agent-session/failures/agent-session-failure'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { journalPendingSubmissionResolutions } from '../../agent-session-journal/submissions/journal-pending-submission-recovery'
import {
  journalLifecycleMutationItemId,
  type JournalLifecycleMutationInput
} from '../../agent-session-journal/writing/journal-lifecycle-mutation'

import {
  endedUnseenMessageBody,
  runningCallEnd,
  terminalAgentJournalBody
} from '../../agent-session-journal/item-lifecycle/journal-terminal-settlement'
import type { ResolveDispatchInput } from '../../agent-session-journal/journal-store-contracts'
import { lostLiveWorkJournalBody } from '../../agent-session-journal/item-lifecycle/journal-subagent-liveness'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from '../startup/structured-agent-session-failure-text'
import {
  hasStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRow
} from '../startup/structured-agent-session-start-failure-row'
import {
  runningTurnLifecycleRevisions,
  watchedExitRevisions,
  type StructuredAgentSessionTurnVerdict,
  type StructuredAgentSessionWatchedExit
} from './structured-agent-session-stale-turn-verdict'
import { exitedRootTurnScope } from './structured-agent-session-exit-turn-scope'
import {
  hasUnfinishedStructuredAgentSessionWork,
  type DeadGenerationJournal
} from './structured-agent-session-unfinished-work'

export type StructuredAgentSessionDeadGenerationInput = {
  journal: DeadGenerationJournal
  sessionId: string
  /** Use the current lease fence after exit release. */
  fence: number
  settlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  pendingSubmissionReason: string
  showUnexpectedExitOutcome?: boolean
  exitFailure?: SubmissionRejectionFact
  failureTextContext?: AgentSessionFailureWordsContext
  /** Share generation-keyed startup failure rows with delivery-loop settlement. `owned`: a start
   *  flight or the child's open still owns its outcome and row. */
  exitedDuringStartup?: { generation: string | null; owned?: boolean }
  /** Refine translator-unverifiable rows after observed exit proof. */
  exit?: StructuredAgentSessionWatchedExit
  unrunRejection?: SubmissionRejectionFact
}

/** Owns selects exited-generation fences; earlier generations settle under their own rules. */
export function planStructuredAgentSessionDeadGeneration(
  input: StructuredAgentSessionDeadGenerationInput,
  owns: (fence: number | undefined) => boolean = () => true,
  authority?: {
    continuingInputs: readonly string[]
    finalizingInputs: readonly { clientMessageId: string; settlementOwner?: true }[]
  }
): { mutations: JournalLifecycleMutationInput[]; dispatches: ResolveDispatchInput[] } {
  const continuing = new Set(authority?.continuingInputs)
  const finalizing = new Set(authority?.finalizingInputs.map((entry) => entry.clientMessageId))
  const order = input.journal.inputOrder
  const workJournal =
    authority && order
      ? {
          ...input.journal,
          inputOrder: {
            recoverableSubmissions: () =>
              order
                .recoverableSubmissions()
                .filter(
                  (entry) =>
                    !(continuing.has(entry.clientMessageId) && entry.dispatchState === 'pending') &&
                    !finalizing.has(entry.clientMessageId)
                )
          }
        }
      : input.journal
  const hasUnfinishedWork = hasUnfinishedStructuredAgentSessionWork(workJournal, input.exit)
  const showUnexpectedExitOutcome = input.showUnexpectedExitOutcome ?? hasUnfinishedWork
  // Leave queued sends to delivery. Failed-start handoffs never ran; ready-child handoffs remain uncertain.
  const startupFailure = input.exitedDuringStartup
    ? structuredAgentSessionStartFailure({ exit: input.exitFailure }, input.failureTextContext)
    : null
  const closed = input.unrunRejection
  const unrun =
    startupFailure ?? (closed && agentSessionFailureWords(closed, { surface: 'rejection' }))
  const dispatches = [
    ...journalPendingSubmissionResolutions(
      (
        input.journal.inputOrder?.recoverableSubmissions() ??
        input.journal.submissions?.() ??
        input.journal.pendingSubmissions?.() ??
        []
      ).filter((entry) => owns(entry.fence)),
      input.fence,
      unrun ? { rejection: unrun } : { reason: input.pendingSubmissionReason }
    )
  ]
  const allItems = providerTimelineExecutionItems(
    (input.journal.statusRead?.() ?? input.journal.snapshot()).items
  )
  const items = allItems.filter((item) => owns(input.journal.itemFence(item.itemId)))
  const proven = watchedExitRevisions(items, input.exit, input.journal)
  const mutations: JournalLifecycleMutationInput[] = []
  if (showUnexpectedExitOutcome && input.exitedDuringStartup && startupFailure) {
    const startKey = input.exitedDuringStartup.generation ?? input.settlementId
    // Delivery owns failure rows for sends; other startup effects need their own row.
    // Existing rejection wording is terminal and must remain unchanged.
    const recordedByDeliveryLoop =
      input.exitedDuringStartup.owned ||
      (input.journal.inputOrder?.recoverableSubmissions() ?? input.journal.submissions?.())?.some(
        isQueuedAgentJournalSubmission
      ) ||
      hasStructuredAgentSessionStartFailureRow(allItems, startKey)
    if (!recordedByDeliveryLoop) {
      mutations.push(structuredAgentSessionStartFailureRow(startKey, startupFailure))
    }
  } else if (showUnexpectedExitOutcome) {
    mutations.push({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: input.settlementId },
      body: {
        kind: 'status',
        ...agentSessionFailureWords(
          input.exitFailure ?? agentSessionFailureFact('providerExited'),
          {
            ...input.failureTextContext,
            surface: 'row'
          }
        ),
        tone: 'error'
      },
      turnScope: exitedRootTurnScope(withRevisions(items, proven), input.verdict)
    })
  }
  const bodies = new Map(allItems.map((item) => [item.itemId, item.body]))
  for (const item of items) {
    // Calls inherit turn outcomes; open reasoning ends without adding duplicate unfinished-work evidence.
    const end = runningCallEnd(item.turnScope, (id) => bodies.get(id), input.verdict.state)
    const terminal = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
    const body = lostLiveWorkJournalBody(terminal ?? item.body) ?? terminal
    if (body) {
      mutations.push({
        kind: 'item',
        itemId: item.itemId,
        body,
        turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }
  mutations.push(...runningTurnLifecycleRevisions(items, input.verdict), ...proven)
  return { mutations, dispatches }
}

function withRevisions(
  items: readonly AgentJournalRenderItem[],
  revisions: readonly JournalLifecycleMutationInput[]
): AgentJournalRenderItem[] {
  const bodies = new Map(
    revisions.flatMap((revision): [string, AgentJournalItemBody][] =>
      revision.kind === 'item' ? [[journalLifecycleMutationItemId(revision), revision.body]] : []
    )
  )
  return items.map((item) => ({ ...item, body: bodies.get(item.itemId) ?? item.body }))
}
