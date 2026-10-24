import { writeClaudeTerminalFailure } from './claude-terminal-failure'
import type { ClaudeContextFacts } from './claude-context-facts'
import { claudeCommandResultEnd } from './claude-command-turn'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import {
  claudeProviderFrameKind,
  claudeResultFailure,
  isSettledClaudeResultKind
} from './claude-structured-provider-fallback'
import { claudeTurnEndForResult } from './claude-turn-lifecycle-item'
import { claudeFrameParentRef, isRootClaudeFrame } from './claude-turn-opening'
import type { ClaudeGoalBackgroundWork } from './claude-background-task-tracker'

export type ClaudeResultJournalContext = Pick<
  ClaudeMessageJournalContext,
  | 'sink'
  | 'streamedBlocks'
  | 'streamedText'
  | 'providerFallback'
  | 'corrections'
  | 'turn'
  | 'authenticationFailures'
  | 'usageLimits'
  | 'threadGoal'
> & {
  prompts: ClaudeJournalPrompts
  context: ClaudeContextFacts
  goalBackgroundWork: () => ClaudeGoalBackgroundWork
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
    authenticationFailures,
    usageLimits,
    threadGoal,
    goalBackgroundWork
  }: ClaudeResultJournalContext,
  message: Record<string, unknown>,
  observedAt: number
): void {
  // Child results can report failures but must never settle the root turn.
  const settlesTurn = isRootClaudeFrame(message)
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
  const alreadyShown = authenticationFailures.resultAlreadyShown(message)
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
