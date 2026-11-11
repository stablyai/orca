import type { AgentJournalSnapshot } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../shared/agent-session/agent-session-wire'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { createAutomationOutputSnapshotBuffer } from './automation-launch'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'

export function resolveChatAutomationRun(
  snapshot: AgentJournalSnapshot,
  messageId: string,
  agent: string,
  queued: AgentSessionSendResult | null = null
) {
  const submission =
    queued && 'submission' in queued
      ? queued.submission
      : snapshot.submissions.find((entry) => entry.clientMessageId === messageId)
  const turnItem = submission ? submissionTurn(snapshot, submission) : undefined
  return {
    submission,
    turnItem,
    observation: observationForResolvedRun(snapshot, submission, turnItem, agent, queued)
  }
}

export function chatAutomationRunObservation(
  snapshot: AgentJournalSnapshot,
  messageId: string,
  agent: string,
  queued: AgentSessionSendResult | null = null
): AutomationRunCompletionObservation | null {
  return resolveChatAutomationRun(snapshot, messageId, agent, queued).observation
}

function observationForResolvedRun(
  snapshot: AgentJournalSnapshot,
  submission: AgentJournalSnapshot['submissions'][number] | undefined,
  turnItem: AgentJournalSnapshot['items'][number] | undefined,
  agent: string,
  queued: AgentSessionSendResult | null = null
): AutomationRunCompletionObservation | null {
  if (queued && 'queued' in queued) {
    return queued.queued.state === 'withdrawn' || queued.queued.state === 'returned'
      ? {
          status: 'dispatch_failed',
          error: `${agent} did not receive this queued prompt. Open the chat before running again.`
        }
      : null
  }
  if (!submission) {
    return null
  }
  const turn = turnItem ? readAgentJournalTurn(turnItem.body) : null
  if (!turn || !turnItem) {
    if (
      submission.dispatchState === 'rejected' &&
      automationAgentDidNotStart(submission.rejection)
    ) {
      return { status: 'dispatch_failed', error: automationAgentDidNotStartError(agent) }
    }
    return submission.dispatchState === 'rejected' || submission.dispatchState === 'unknown'
      ? {
          status: 'dispatch_failed',
          error: `${agent} could not confirm this run's prompt. Open the chat before running it again.`
        }
      : null
  }
  if (turn.state === 'running') {
    return null
  }
  const buffer = createAutomationOutputSnapshotBuffer()
  for (const item of snapshot.items) {
    if (
      item.agentId ||
      item.turnScope?.kind !== 'turn' ||
      item.turnScope.turnItemId !== turnItem.itemId ||
      item.body.kind !== 'message' ||
      item.body.role !== 'assistant'
    ) {
      continue
    }
    for (const block of item.body.blocks) {
      if (block.type === 'text') {
        buffer.append(`${block.text}\n`)
      }
    }
  }
  const outcome = readAgentJournalTurnOutcome(turn)
  return {
    status: outcome === 'success' ? 'completed' : 'dispatch_failed',
    outputSnapshot: buffer.snapshot(),
    error:
      outcome === 'success'
        ? null
        : outcome === 'cancellation' || turn.state === 'interrupted'
          ? `${agent} was Interrupted. Open the chat or run the automation again.`
          : `${agent} did not complete this run. Open the chat and try again.`
  }
}

function submissionTurn(
  snapshot: AgentJournalSnapshot,
  submission: AgentJournalSnapshot['submissions'][number]
) {
  const keys = new Set([
    agentJournalSubmissionKey(submission.clientMessageId),
    ...(submission.providerItemId ? [submission.providerItemId] : [])
  ])
  return snapshot.items.find((item) => {
    const turn = readAgentJournalTurn(item.body)
    return (
      turn &&
      !item.agentId &&
      (keys.has(turn.userItemId ?? '') ||
        (submission.answeredInTurn?.via === 'start' &&
          submission.answeredInTurn.turnItemId === item.itemId))
    )
  })
}

/** Rejections that mean the agent never finished starting, so it never saw the prompt: the start
 *  passed its limit or was stopped while starting (`hostStopped`), or the agent exited or failed
 *  while starting. */
const DID_NOT_START_KINDS: ReadonlySet<string> = new Set([
  'hostStopped',
  'providerStartFailed',
  'startFailed'
])

export function automationAgentDidNotStart(rejection: { kind: string } | undefined): boolean {
  return rejection !== undefined && DID_NOT_START_KINDS.has(rejection.kind)
}

export function automationAgentDidNotStartError(agent: string): string {
  return `${agent} did not start (the machine may have slept or startup timed out), so it never received this run's prompt. Run the automation again.`
}
