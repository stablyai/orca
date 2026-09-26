import {
  agentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { partitionJournalLifecycleMutations } from '../agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import { cancelledJournalPromptBody } from '../agent-session-journal/journal-prompt-body-bounds'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  agentSessionFailureRejection,
  startupFailureFromExit
} from './structured-agent-session-failure-text'
import { structuredAgentSessionStartFailureRow } from './structured-agent-session-start-failure-row'
import {
  runningTurnLifecycleRevisions,
  type StructuredAgentSessionTurnVerdict
} from './structured-agent-session-stale-turn-verdict'

export const UNEXPECTED_PROVIDER_EXIT_OUTCOME =
  'The provider stopped while this response was in progress. You can continue in this conversation.'

/** Bounds the exit reason a settlement retry keeps as the lease's log evidence. */
export const MAX_UNEXPECTED_EXIT_REASON_CHARS = 512

type DeadGenerationSubmission = Pick<
  ReturnType<AgentSessionJournal['submissions']>[number],
  'clientMessageId' | 'dispatchState' | 'recovered' | 'handoverRecorded' | 'handedOverAt'
>

export type DeadGenerationJournal = {
  appendLifecycleBatch: AgentSessionJournal['appendLifecycleBatch']
  markPendingSubmissionsUnknown: AgentSessionJournal['markPendingSubmissionsUnknown']
  rejectPendingSubmissions: AgentSessionJournal['rejectPendingSubmissions']
  snapshot: () => Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
  pendingSubmissions?: AgentSessionJournal['pendingSubmissions']
  submissions?: () => DeadGenerationSubmission[]
}

export type StructuredAgentSessionUnfinishedWork = {
  items: AgentJournalRenderItem[]
  hadUnsettledSubmissions: boolean
}

export function captureUnfinishedStructuredAgentSessionWork(
  journal: DeadGenerationJournal
): StructuredAgentSessionUnfinishedWork {
  return {
    items: journal.snapshot().items.filter(isUnfinishedItem),
    hadUnsettledSubmissions: hasUnsettledSubmission(journal)
  }
}

function hasUnfinishedStructuredAgentSessionWork(journal: DeadGenerationJournal): boolean {
  const work = captureUnfinishedStructuredAgentSessionWork(journal)
  return work.hadUnsettledSubmissions || work.items.length > 0
}

export function unfinishedStructuredAgentSessionWorkWasInterrupted(
  before: StructuredAgentSessionUnfinishedWork,
  journal: DeadGenerationJournal,
  observedExitAt: number
): boolean {
  const currentSnapshot = journal.snapshot()
  if (hasUnsettledSubmission(journal) || currentSnapshot.items.some(isInProgressItem)) {
    return true
  }
  if (
    currentSnapshot.items.some((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn?.state === 'interrupted' && turn.completedAt === observedExitAt
    })
  ) {
    return true
  }
  const inProgressBefore = before.items.filter(isInProgressItem)
  if (inProgressBefore.length === 0) {
    return false
  }
  const currentItems = new Map(currentSnapshot.items.map((item) => [item.itemId, item]))
  const runningTurns = inProgressBefore.filter(
    (item) => readAgentJournalTurn(item.body)?.state === 'running'
  )
  const outcomeItems = runningTurns.length > 0 ? runningTurns : inProgressBefore
  return outcomeItems.some((item) => !isCleanlySettled(currentItems.get(item.itemId)))
}

export async function settleStructuredAgentSessionDeadGeneration(input: {
  journal: DeadGenerationJournal
  sessionId: string
  fence: number
  settlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  pendingSubmissionReason: string
  showUnexpectedExitOutcome?: boolean
  /** Why the provider stopped, as the adapter told it: recorded beside the row, never in its text. */
  exitFailure?: AgentSessionFailureFact
  /** The provider never finished starting: the start that failed, keyed by the child's
   *  generation. Its row is the one the delivery loop writes for the same start. */
  exitedDuringStartup?: { generation: string | null }
  onError?: (sessionId: string, error: unknown) => void
}): Promise<boolean> {
  try {
    const hasUnfinishedWork = hasUnfinishedStructuredAgentSessionWork(input.journal)
    const showUnexpectedExitOutcome = input.showUnexpectedExitOutcome ?? hasUnfinishedWork
    if (!showUnexpectedExitOutcome && !hasUnfinishedWork) {
      return true
    }
    // A queued message is the delivery loop's to settle: it was never handed to this child. A
    // child that never proved its start accepted nothing either — input is written only after it
    // initializes — so every send it was handed is rejected with the child's own diagnostic. A
    // proven child's handed-over sends stay in doubt.
    const startupFailure = input.exitedDuringStartup
      ? startupFailureFromExit(input.exitFailure)
      : null
    await (startupFailure
      ? input.journal.rejectPendingSubmissions(
          input.fence,
          agentSessionFailureRejection(startupFailure)
        )
      : input.journal.markPendingSubmissionsUnknown(input.fence, input.pendingSubmissionReason))
    const items = input.journal.snapshot().items
    const mutations: JournalLifecycleMutationInput[] = []
    if (showUnexpectedExitOutcome && input.exitedDuringStartup && startupFailure) {
      // Until views stop starting children, a start can die with nothing queued for the loop.
      mutations.push(
        structuredAgentSessionStartFailureRow(
          input.exitedDuringStartup.generation ?? input.settlementId,
          startupFailure
        )
      )
    } else if (showUnexpectedExitOutcome) {
      mutations.push({
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: input.settlementId },
        body: {
          kind: 'status',
          text: UNEXPECTED_PROVIDER_EXIT_OUTCOME,
          failure: input.exitFailure ?? agentSessionFailureFact('providerExited')
        }
      })
    }
    for (const item of items) {
      const identity = parseAgentJournalItemKey(item.itemId)
      const body = terminalDeadGenerationBody(item)
      if (identity && body) {
        mutations.push({ kind: 'item', identity, body })
      }
    }
    mutations.push(...runningTurnLifecycleRevisions(items, input.verdict))
    const batchId = `dead-generation:${input.settlementId}`
    for (const chunk of partitionJournalLifecycleMutations(batchId, mutations)) {
      await input.journal.appendLifecycleBatch({
        settlementId: chunk.settlementId,
        fence: input.fence,
        recovered: true,
        mutations: chunk.mutations
      })
    }
    return true
  } catch (error) {
    input.onError?.(input.sessionId, error)
    return false
  }
}

function terminalDeadGenerationBody(item: AgentJournalRenderItem): AgentJournalItemBody | null {
  if (item.body.kind === 'tool-call' && item.body.state === 'running') {
    return { ...item.body, state: 'failed' }
  }
  if (item.body.kind === 'approval' || item.body.kind === 'question') {
    return item.body.resolution.state === 'pending' ? cancelledJournalPromptBody(item.body) : null
  }
  return null
}

function isUnfinishedItem(item: AgentJournalRenderItem): boolean {
  return (
    readAgentJournalTurn(item.body)?.state === 'running' ||
    terminalDeadGenerationBody(item) !== null
  )
}

/** Work that means the provider was MID-RESPONSE. A pending approval or question is the provider
 *  waiting on the user, so dying while one sits there interrupted nothing — it still needs
 *  cancelling, but it must not claim a response was in progress. */
function isInProgressItem(item: AgentJournalRenderItem): boolean {
  return (
    readAgentJournalTurn(item.body)?.state === 'running' ||
    (item.body.kind === 'tool-call' && item.body.state === 'running')
  )
}

function isCleanlySettled(item: AgentJournalRenderItem | undefined): boolean {
  const turn = readAgentJournalTurn(item?.body)
  if (turn) {
    return turn.state === 'completed'
  }
  if (item?.body.kind === 'tool-call') {
    return item.body.state === 'completed'
  }
  if (item?.body.kind === 'approval' || item?.body.kind === 'question') {
    return item.body.resolution.state === 'resolved'
  }
  return false
}

function hasUnsettledSubmission(journal: DeadGenerationJournal): boolean {
  const submissions = journal.submissions?.()
  return submissions
    ? submissions.some(
        (submission) =>
          // A queued message is not work in progress: nothing has it yet.
          (submission.dispatchState === 'pending' &&
            !(submission.handoverRecorded && submission.handedOverAt === undefined)) ||
          (submission.dispatchState === 'unknown' && submission.recovered !== true)
      )
    : (journal.pendingSubmissions?.().length ?? 0) > 0
}
