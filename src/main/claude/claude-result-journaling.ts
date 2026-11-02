import { writeClaudeTerminalFailure } from './claude-terminal-failure'
import type { ClaudeContextFacts } from './claude-context-facts'
import { claudeCommandEnd } from './claude-command-turn'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import type { ClaudeJournalPrompts } from './structured/journal/claude-structured-journal-prompts'
import {
  claudeProviderFrameKind,
  claudeResultFailure,
  isSettledClaudeResultKind
} from './structured/launch/claude-structured-provider-fallback'
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
  | 'assistantFailures'
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
    assistantFailures,
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
  const command = settlesTurn ? turn.command : null
  const commandResult = command ? claudeCommandEnd(command, message, observedAt) : null
  if (command && !commandResult) {
    return
  }
  const failure = claudeResultFailure(message, leftToStop)
  // A command's quota cause needs its own failed verdict, not only a failed envelope.
  const compactionFailure =
    command &&
    commandResult?.end.outcome === 'failure' &&
    !leftToStop &&
    (command.failed !== null || failure !== null)
      ? { ...command.failed, rejections: command.rejections }
      : undefined
  const usageLimit = settlesTurn
    ? usageLimits.result(message, !command && failure !== null, usageEvidence, compactionFailure)
    : null
  // A sign-in notice from the hidden reply outranks quota, as on an ordinary send. Claude also
  // labels a 403 access denial authentication_failed; its result, not sign-in guidance, says why.
  const notice = compactionFailure && message.api_error_status !== 403 ? command?.notice : null
  const terminalFailure = notice || usageLimit
  if (command && commandResult?.row && !terminalFailure) {
    sink.appendItem(command.resultIdentity, commandResult.row, { turnScope: endedTurnScope })
  }
  if (terminalFailure && endedTurnIdentity) {
    writeClaudeTerminalFailure(sink, endedTurnIdentity, terminalFailure)
  }
  if (settlesTurn) {
    turn.suppressReopenOnFailure(message.is_error === true)
    corrections.abandon()
    streamedText.finish({ completedAt: observedAt })
    context.settle(
      message,
      commandResult?.end ?? claudeTurnEndForResult(message, observedAt, leftToStop)
    )
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
  if (terminalFailure && endedTurnIdentity) {
    return
  }
  const alreadyShown = assistantFailures.resultAlreadyShown(message)
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
