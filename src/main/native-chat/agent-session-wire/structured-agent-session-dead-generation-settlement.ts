import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { journalPendingSubmissionResolutions } from '../agent-session-journal/journal-pending-submission-recovery'
import {
  journalLifecycleMutationItemId,
  type JournalLifecycleMutationInput
} from '../agent-session-journal/journal-row-builders'
import {
  endedUnseenMessageBody,
  runningCallEnd,
  terminalAgentJournalBody
} from '../agent-session-journal/journal-terminal-settlement'
import type { ResolveDispatchInput } from '../agent-session-journal/journal-store-contracts'
import { lostLiveWorkJournalBody } from '../agent-session-journal/journal-subagent-liveness'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import {
  hasStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRow
} from './structured-agent-session-start-failure-row'
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
import { codexUnopenedSendResolutions } from './structured-agent-session-unopened-send-withdrawal'

export { settleStaleStructuredAgentSessionState } from './structured-agent-session-stale-state-settlement'

/** Bounds the exit reason the lease keeps as log evidence; a provider diagnostic is held to the
 *  same cap. */
export const MAX_UNEXPECTED_EXIT_REASON_CHARS = MAX_PROVIDER_DIAGNOSTIC_CHARS

export type StructuredAgentSessionDeadGenerationInput = {
  journal: DeadGenerationJournal
  sessionId: string
  /** The fence the rows are written at: the lease's current one once the exit released it. */
  fence: number
  settlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  pendingSubmissionReason: string
  showUnexpectedExitOutcome?: boolean
  /** Why the provider stopped, as the adapter told it; the row's sentence is this fact's. */
  exitFailure?: SubmissionRejectionFact
  /** Who a failed start's sentence names. */
  failureTextContext?: AgentSessionFailureWordsContext
  /** The provider never finished starting: the start that failed, keyed by the child's
   *  generation. Its row is the one the delivery loop writes for the same start. */
  exitedDuringStartup?: { generation: string | null }
  /** The exit, watched: what that child's own translator could only end `unverifiable` (its stream
   *  closed before the exit was proven) is revised in this batch. */
  exit?: StructuredAgentSessionWatchedExit
  /** A person's Stop ended a starting child before what it was handed could run: each is rejected so. */
  unrunRejection?: SubmissionRejectionFact
}

/** The exit's rows, read from the journal as it stands. `owns`: which fences are the exited
 *  generation's (and later); the rest are an earlier generation's, settled by its own rule. */
export function planStructuredAgentSessionDeadGeneration(
  input: StructuredAgentSessionDeadGenerationInput,
  owns: (fence: number | undefined) => boolean = () => true
): { mutations: JournalLifecycleMutationInput[]; dispatches: ResolveDispatchInput[] } {
  const hasUnfinishedWork = hasUnfinishedStructuredAgentSessionWork(input.journal, input.exit)
  const showUnexpectedExitOutcome = input.showUnexpectedExitOutcome ?? hasUnfinishedWork
  if (!showUnexpectedExitOutcome && !hasUnfinishedWork) {
    return { mutations: [], dispatches: [] }
  }
  // A queued message is the delivery loop's to settle: it was never handed to this child. A send
  // a child still starting was handed and never echoed did not run, and its root is gone: it is
  // rejected, with the child's own diagnostic or as the Stop that ended it. A proven child's
  // handed-over sends stay in doubt.
  const startupFailure = input.exitedDuringStartup
    ? structuredAgentSessionStartFailure({ exit: input.exitFailure }, input.failureTextContext)
    : null
  const closed = input.unrunRejection
  const unrun =
    startupFailure ?? (closed && agentSessionFailureWords(closed, { surface: 'rejection' }))
  const withdrawn = unrun ? [] : codexUnopenedSendResolutions(input.journal, input.fence)
  const withdrawnIds = new Set(withdrawn.map((entry) => entry.clientMessageId))
  const dispatches = [
    ...withdrawn,
    ...journalPendingSubmissionResolutions(
      (input.journal.submissions?.() ?? input.journal.pendingSubmissions?.() ?? []).filter(
        (entry) => !withdrawnIds.has(entry.clientMessageId) && owns(entry.fence)
      ),
      input.fence,
      unrun ? { rejection: unrun } : { reason: input.pendingSubmissionReason }
    )
  ]
  const allItems = input.journal.snapshot().items
  const items = allItems.filter((item) => owns(input.journal.itemFence(item.itemId)))
  const proven = watchedExitRevisions(items, input.exit, input.journal)
  const mutations: JournalLifecycleMutationInput[] = []
  if (showUnexpectedExitOutcome && input.exitedDuringStartup && startupFailure) {
    const startKey = input.exitedDuringStartup.generation ?? input.settlementId
    // A start a message waited on is the delivery loop's to record, before or after this exit,
    // in the words it rejected the message with; this row is for a command, goal or rewind start.
    // A row already written stays: rejected is terminal, so its words are not reworded.
    const recordedByDeliveryLoop =
      input.journal.submissions?.().some(isQueuedAgentJournalSubmission) ||
      hasStructuredAgentSessionStartFailureRow(allItems, startKey)
    if (!recordedByDeliveryLoop) {
      mutations.push(structuredAgentSessionStartFailureRow(startKey, startupFailure))
    }
  } else if (showUnexpectedExitOutcome) {
    // The turn the exit ended, and an error so no fold ever hides why it stopped.
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
    // Ended as its turn is: a proven death cuts a running call short. An open reasoning row is
    // ended too, but is not unfinished work: its running turn already says so.
    const end = runningCallEnd(item.turnScope, (id) => bodies.get(id), input.verdict.state)
    const terminal = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
    // One revision per item: its live subagents and background tasks end with it.
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
