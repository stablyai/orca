import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { requiresTerminalSettlement } from '../agent-session-journal/journal-terminal-settlement'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  watchedExitRevisions,
  type StructuredAgentSessionWatchedExit
} from './structured-agent-session-stale-turn-verdict'
import type { UnopenedSendJournal } from './structured-agent-session-unopened-send-withdrawal'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'

export type DeadGenerationJournal = UnopenedSendJournal & {
  appendPlannedLifecycleBatch: AgentSessionJournal['appendPlannedLifecycleBatch']
  pendingSubmissions?: AgentSessionJournal['pendingSubmissions']
  itemFence: AgentSessionJournal['itemFence']
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

export function hasUnfinishedStructuredAgentSessionWork(
  journal: DeadGenerationJournal,
  exit?: StructuredAgentSessionWatchedExit
): boolean {
  const work = captureUnfinishedStructuredAgentSessionWork(journal)
  return (
    work.hadUnsettledSubmissions ||
    work.items.length > 0 ||
    watchedExitRevisions(journal.snapshot().items, exit, journal).length > 0
  )
}

export function unfinishedStructuredAgentSessionWorkWasInterrupted(
  before: StructuredAgentSessionUnfinishedWork,
  journal: DeadGenerationJournal,
  observedExitAt: number,
  exit?: StructuredAgentSessionWatchedExit,
  heldSends?: ReadonlySet<string>
): boolean {
  const currentSnapshot = journal.snapshot()
  if (
    journal
      .submissions?.()
      .some(
        (send) =>
          heldSends?.has(send.clientMessageId) &&
          send.fence === exit?.ownerFence &&
          !isQueuedAgentJournalSubmission(send) &&
          (send.dispatchState === 'pending' || send.dispatchState === 'unknown')
      ) ||
    currentSnapshot.items.some(isInProgressStructuredAgentSessionItem)
  ) {
    return true
  }
  // Stream closure may mark a turn unverifiable before the child’s exit arrives.
  if (watchedExitRevisions(currentSnapshot.items, exit, journal).length > 0) {
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
  const inProgressBefore = before.items.filter(isInProgressStructuredAgentSessionItem)
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

function isUnfinishedItem(item: AgentJournalRenderItem): boolean {
  return requiresTerminalSettlement(item.body)
}

/** Pending prompts wait on the user; cancel them without claiming the provider was mid-response. */
export function isInProgressStructuredAgentSessionItem(item: AgentJournalRenderItem): boolean {
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
          // Unhanded queued messages are not work in progress.
          (submission.dispatchState === 'pending' &&
            !(submission.handoverRecorded && submission.handedOverAt === undefined)) ||
          (submission.dispatchState === 'unknown' && submission.recovered !== true)
      )
    : (journal.pendingSubmissions?.().length ?? 0) > 0
}
