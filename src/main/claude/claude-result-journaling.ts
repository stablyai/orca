import { writeClaudeTerminalFailure } from './claude-terminal-failure'
import type { ClaudeContextFacts } from './claude-context-facts'
import { claudeCommandResultEnd } from './claude-command-turn'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import type { ClaudeJournalPrompts } from './structured/journal/claude-structured-journal-prompts'
import {
  claudeProviderFrameKind,
  claudeResultFailure,
  isSettledClaudeResultKind
} from './structured/launch/claude-structured-provider-fallback'
import { claudeTurnEndForResult } from './claude-turn-lifecycle-item'
import { claudeFrameParentRef, isRootClaudeFrame } from './claude-turn-opening'
import { claudeResultUserMessageUuids } from './claude-replay-turn-resolution'
import type { ClaudeGoalBackgroundWork } from './claude-background-task-tracker'
import type { ClaudeJournalTranslatorDeps } from './claude-journal-translator-contract'

export type ClaudeResultJournalContext = Pick<
  ClaudeMessageJournalContext,
  | 'sink'
  | 'streamedBlocks'
  | 'streamedText'
  | 'providerFallback'
  | 'corrections'
  | 'turn'
  | 'assistantFailures'
  | 'usageLimits'
  | 'threadGoal'
> & {
  prompts: ClaudeJournalPrompts
  context: ClaudeContextFacts
  goalBackgroundWork: () => ClaudeGoalBackgroundWork
  acceptStartupFailure?: ClaudeJournalTranslatorDeps['acceptStartupFailure']
}

const namesClaudeInput = (value: unknown): boolean => typeof value === 'string' && value !== ''

/** Input it answered (receipts, a resumed turn) or model round-trips mean the result is a turn's own. */
function claudeResultShowsTurnWork(message: Record<string, unknown>): boolean {
  return (
    namesClaudeInput(message.user_message_uuid) ||
    (Array.isArray(message.user_message_uuids) &&
      message.user_message_uuids.some(namesClaudeInput)) ||
    namesClaudeInput(message.resume_reason) ||
    (typeof message.num_turns === 'number' && message.num_turns > 0)
  )
}

export function journalClaudeResult(
  {
    sink,
    streamedBlocks,
    streamedText,
    providerFallback,
    corrections,
    turn,
    prompts,
    context,
    assistantFailures,
    usageLimits,
    threadGoal,
    goalBackgroundWork,
    acceptStartupFailure
  }: ClaudeResultJournalContext,
  message: Record<string, unknown>,
  observedAt: number
): void {
  // Child results can report failures but must never settle the root turn.
  const settlesTurn =
    isRootClaudeFrame(message) && turn.settlesWithResult(claudeResultUserMessageUuids(message))
  const endedTurnScope = turn.turnScope
  const endedTurnIdentity = turn.identity
  const usageEvidence = turn.usageLimitEvidence
  const endedTurnStartedAt = turn.startedAt
  const turnId = settlesTurn ? turn.id : null
  const leftToStop = turnId !== null && sink.journalStopDecidesTurn?.(turnId, observedAt) === true
  // Retry owed prompt cancellations before a command result can return.
  if (settlesTurn) {
    prompts.retryPendingCancellations()
  }
  const commandEnd = settlesTurn ? claudeCommandResultEnd(turn, sink, message, observedAt) : null
  if (commandEnd === 'another-input') {
    return
  }
  const failure = claudeResultFailure(message, leftToStop)
  const usageLimit = settlesTurn
    ? usageLimits.result(message, failure !== null, usageEvidence)
    : null
  if (usageLimit && endedTurnIdentity) {
    writeClaudeTerminalFailure(sink, endedTurnIdentity, usageLimit)
  }
  if (settlesTurn) {
    turn.suppressReopenOnFailure(message.is_error === true)
    corrections.abandon()
    streamedText.finish({ completedAt: observedAt })
    context.settle(message, commandEnd ?? claudeTurnEndForResult(message, observedAt, leftToStop))
    streamedBlocks.clear()
    streamedText.settle()
  }
  const goal = threadGoal.settle(
    message,
    {
      backgroundWork: goalBackgroundWork(),
      stoppedByPerson: leftToStop,
      turnStartedAt: endedTurnStartedAt
    },
    observedAt
  )
  if (goal) {
    sink.appendItem(goal.identity, goal.body, { turnScope: endedTurnScope })
    sink.publish()
  }
  const kind = claudeProviderFrameKind(message)
  if (usageLimit && endedTurnIdentity) {
    return
  }
  const alreadyShown = assistantFailures.resultAlreadyShown(message)
  // Only a still-starting acquisition that fails its open with this failure may take over its row.
  if (
    failure &&
    settlesTurn &&
    endedTurnIdentity === null &&
    !usageLimit &&
    !alreadyShown &&
    !claudeResultShowsTurnWork(message) &&
    acceptStartupFailure?.(message) === true
  ) {
    return
  }
  if ((failure || !isSettledClaudeResultKind(kind)) && !alreadyShown) {
    providerFallback.append(
      kind,
      message,
      usageLimit ?? failure?.text,
      undefined,
      { reportsFailure: failure !== null },
      settlesTurn
        ? () => ({ turnScope: endedTurnScope })
        : corrections.stampFor(claudeFrameParentRef(message))
    )
  }
}
