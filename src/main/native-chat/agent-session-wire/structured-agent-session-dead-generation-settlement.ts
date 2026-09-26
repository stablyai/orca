import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { partitionJournalLifecycleMutations } from '../agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import {
  boundJournalStatusText,
  cancelledJournalPromptBody
} from '../agent-session-journal/journal-prompt-body-bounds'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence,
  type StructuredAgentSessionTurnVerdict
} from './structured-agent-session-stale-turn-verdict'

export const UNEXPECTED_PROVIDER_EXIT_OUTCOME =
  'The provider stopped while this response was in progress. You can continue in this conversation.'

/** A provider may put a whole stderr dump in its exit reason; unbounded it would push the
 *  actionable tail past the row's byte cap and lose it to truncation. */
export const MAX_UNEXPECTED_EXIT_REASON_CHARS = 512

/** The cause is the only thing separating an auth failure from an OOM kill, so it is carried
 *  into the copy rather than left in the durable record nothing renders. */
export function unexpectedProviderExitOutcome(reason?: string): string {
  const detail = exitReasonDetail(reason)
  return detail
    ? `The provider stopped while this response was in progress: ${detail}. You can continue in this conversation.`
    : UNEXPECTED_PROVIDER_EXIT_OUTCOME
}

/** A restart that produced no child, answered to the send that asked for it; its cause is the
 *  whole story, and nothing is remembered, so the next try is a fresh one. A new chat is offered
 *  only when the host holds nothing this chat could restart from. */
export function ownerRestartFailedOutcome(input: {
  agentName: string
  reason?: string
  resumable: boolean
}): string {
  const detail = exitReasonDetail(input.reason)
  const failed = detail
    ? `${input.agentName} couldn't restart: ${detail}.`
    : `${input.agentName} couldn't restart.`
  return input.resumable ? failed : `${failed} Start a new chat to continue.`
}

/** A start that never finished has no response to interrupt; its cause is the whole story. */
export function providerStartupFailureOutcome(reason?: string): string {
  const detail = exitReasonDetail(reason)
  return detail
    ? `The provider stopped before it finished starting: ${detail}.`
    : 'The provider stopped before it finished starting.'
}

/** Why a send a child that never started left unwritten was rejected. The child's own diagnostic is
 *  the cause the user can act on, so it is the reason, in the words the chat row uses. */
export function providerStartupFailureRejection(cause?: unknown): string {
  return providerStartupFailureOutcome(
    cause === undefined ? undefined : cause instanceof Error ? cause.message : String(cause)
  )
}

function exitReasonDetail(reason: string | undefined): string | undefined {
  return reason
    ?.slice(0, MAX_UNEXPECTED_EXIT_REASON_CHARS)
    .trim()
    .replace(/[.\s]+$/, '')
}

type DeadGenerationSubmission = Pick<
  ReturnType<AgentSessionJournal['submissions']>[number],
  'clientMessageId' | 'dispatchState' | 'recovered'
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
  /** Why the provider stopped, when the host has it. Rendered with the outcome copy. */
  unexpectedExitReason?: string
  /** The provider never finished starting; the outcome says so instead of naming a response. */
  exitedDuringStartup?: boolean
  onError?: (sessionId: string, error: unknown) => void
}): Promise<boolean> {
  try {
    const hasUnfinishedWork = hasUnfinishedStructuredAgentSessionWork(input.journal)
    const showUnexpectedExitOutcome = input.showUnexpectedExitOutcome ?? hasUnfinishedWork
    if (!showUnexpectedExitOutcome && !hasUnfinishedWork) {
      return true
    }
    // A child that never proved its start accepted nothing — input is written only after it
    // initializes — so every send it left unanswered is provably unwritten and is rejected with the
    // child's own diagnostic. A proven child's unanswered sends stay in doubt.
    await (input.exitedDuringStartup
      ? input.journal.rejectPendingSubmissions(
          input.fence,
          providerStartupFailureRejection(input.unexpectedExitReason)
        )
      : input.journal.markPendingSubmissionsUnknown(input.fence, input.pendingSubmissionReason))
    const items = input.journal.snapshot().items
    const mutations: JournalLifecycleMutationInput[] = []
    if (showUnexpectedExitOutcome) {
      mutations.push({
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: input.settlementId },
        body: {
          kind: 'status',
          text: boundJournalStatusText(
            input.exitedDuringStartup
              ? providerStartupFailureOutcome(input.unexpectedExitReason)
              : unexpectedProviderExitOutcome(input.unexpectedExitReason)
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
 * death evidence each time, so nothing is owed in between. Only an observed exit earns an end time
 * and the exit copy. Must run before a new child's buffered events land, or a live turn would be
 * judged.
 */
export async function settleStaleStructuredAgentSessionState(input: {
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
}): Promise<number> {
  const { journal } = input
  const items = journal.snapshot().items
  const verdict = turnVerdictFromDeathEvidence(input.deathEvidence)
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
  mutations.push(...runningTurnLifecycleRevisions(items, verdict))
  if (verdict.state === 'interrupted' && items.some(isInProgressItem)) {
    mutations.unshift({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: settlementId },
      body: {
        kind: 'status',
        text: boundJournalStatusText(unexpectedProviderExitOutcome(input.deathEvidence?.detail))
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
          submission.dispatchState === 'pending' ||
          (submission.dispatchState === 'unknown' && submission.recovered !== true)
      )
    : (journal.pendingSubmissions?.().length ?? 0) > 0
}
