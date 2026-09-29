import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
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
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import {
  hasStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRow
} from './structured-agent-session-start-failure-row'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  provenUnverifiableTurnRevisions,
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence,
  type StructuredAgentSessionTurnVerdict
} from './structured-agent-session-stale-turn-verdict'

/** Bounds the exit reason the lease keeps as log evidence; a provider diagnostic is held to the
 *  same cap. */
export const MAX_UNEXPECTED_EXIT_REASON_CHARS = MAX_PROVIDER_DIAGNOSTIC_CHARS

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
  /** Why the provider stopped, as the adapter told it; the row's sentence is this fact's. */
  exitFailure?: SubmissionRejectionFact
  /** Who a failed start's sentence names. */
  failureTextContext?: AgentSessionFailureWordsContext
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
      ? structuredAgentSessionStartFailure({ exit: input.exitFailure }, input.failureTextContext)
      : null
    await (startupFailure
      ? input.journal.rejectPendingSubmissions(input.fence, startupFailure)
      : input.journal.markPendingSubmissionsUnknown(input.fence, input.pendingSubmissionReason))
    const items = input.journal.snapshot().items
    const mutations: JournalLifecycleMutationInput[] = []
    if (showUnexpectedExitOutcome && input.exitedDuringStartup && startupFailure) {
      const startKey = input.exitedDuringStartup.generation ?? input.settlementId
      // A start a message waited on is the delivery loop's to record, before or after this exit,
      // in the words it rejected the message with; this row is for a command, goal or rewind start.
      // A row already written stays: rejected is terminal, so its words are not reworded.
      const recordedByDeliveryLoop =
        input.journal.submissions?.().some(isQueuedAgentJournalSubmission) ||
        hasStructuredAgentSessionStartFailureRow(items, startKey)
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
          )
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

/**
 * Settles whatever a generation with no child in this process left running: found when a new child
 * is acquired, or when a chat is reopened for reading. Derived from the journal and the lease's
 * death evidence each time, so nothing is owed in between. Proven death ends the turn interrupted,
 * and a proof written after an earlier settle revises what that settle left `unverifiable`. Must
 * run before a new child's buffered events land, or a live turn would be judged.
 */
export async function settleStaleStructuredAgentSessionState(input: {
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
  /** Who the exit row names. */
  failureTextContext?: AgentSessionFailureWordsContext
}): Promise<number> {
  const { journal } = input
  const items = journal.snapshot().items
  // Each turn is judged by the evidence only if it names that turn's owner.
  const verdictFor = (item: AgentJournalRenderItem) =>
    turnVerdictFromDeathEvidence(input.deathEvidence, journal.itemFence(item.itemId))
  // Per attempt: a retry re-partitions only what is left, and a reused chunk id would skip it.
  const generation = input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`
  const settlementId = `stale-session:${input.sessionId}:${input.fence}:${generation}`
  const mutations: JournalLifecycleMutationInput[] = []
  for (const item of items) {
    const identity = parseAgentJournalItemKey(item.itemId)
    const body = terminalDeadGenerationBody(item)
    if (identity && body) {
      mutations.push({ kind: 'item', identity, body })
    }
  }
  const proven = provenUnverifiableTurnRevisions(items, input.deathEvidence, journal)
  mutations.push(
    ...items.flatMap((item) => runningTurnLifecycleRevisions([item], verdictFor(item))),
    ...proven
  )
  const evidence = input.deathEvidence
  if (
    evidence &&
    (proven.length > 0 ||
      items.some((item) => isInProgressItem(item) && verdictFor(item).state === 'interrupted'))
  ) {
    mutations.unshift({
      kind: 'item',
      // Named by the death it explains, so a retry after a partly written settle adds no second row.
      identity: {
        provider: 'orca',
        clientMessageId: `stale-session:${input.sessionId}:death-${evidence.ownerFence ?? 'unowned'}-${evidence.observedAt}`
      },
      // The death evidence is Orca's log text, never a sentence for a person: the row says only
      // that the provider stopped.
      body: {
        kind: 'status',
        ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
          ...input.failureTextContext,
          surface: 'row'
        })
      }
    })
  }
  for (const chunk of partitionJournalLifecycleMutations(settlementId, mutations)) {
    await journal.appendLifecycleBatch({
      settlementId: chunk.settlementId,
      fence: input.fence,
      recovered: true,
      mutations: chunk.mutations
    })
  }
  return mutations.length
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
