import { writeClaudeTerminalFailure } from './claude-terminal-failure'
import { claudeResultOutcome } from '../turns/claude-result-outcome'
import { writeClaudeStopReadings } from '../../claude-stop-readings'
import { journalClaudeGoal } from '../../claude-goal-journaling'
import { estimateStructuredAgentSessionItemBytes } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink-estimate'
import type { ClaudeContextFacts } from '../../context-usage/claude-context-facts'
import { claudeCommandEnd } from '../turns/claude-command-turn'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import {
  claudeProviderFrameKind,
  claudeResultFailure,
  isSettledClaudeResultKind
} from '../launch/claude-structured-provider-fallback'
import { claudeTurnEndForResult } from '../turns/claude-turn-lifecycle-item'
import { claudeFrameParentRef, isRootClaudeFrame } from '../turns/claude-turn-opening'
import type { ClaudeGoalBackgroundWork } from '../../background-tasks/claude-background-task-tracker'
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
  const settlesTurn = isRootClaudeFrame(message)
  const endedTurnScope = turn.turnScope
  const endedTurnIdentity = turn.identity
  const usageEvidence = turn.usageLimitEvidence
  const endedTurnStartedAt = turn.startedAt
  const turnId = settlesTurn ? turn.id : null
  // A Stop changes only an unaborted error's reading; the writer decides it at its position.
  const stopCheck =
    turnId !== null && claudeResultOutcome(message) !== claudeResultOutcome(message, true)
      ? { turnId, endedAt: observedAt }
      : null
  // Retry owed prompt cancellations before a command result can return.
  if (settlesTurn) {
    prompts.retryPendingCancellations()
  }
  const command = settlesTurn ? turn.command : null
  const commandResult = command ? claudeCommandEnd(command, message, observedAt) : null
  if (command && !commandResult) {
    return
  }
  const failure = claudeResultFailure(message)
  // A command's quota cause needs its own failed verdict, not only a failed envelope.
  const compactionFailure =
    command &&
    commandResult?.end.outcome === 'failure' &&
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
  } else if (command && commandResult?.row && stopCheck) {
    // Stopped, the command's own result row stands in for the failure.
    const { resultIdentity: identity } = command
    const body = commandResult.row
    writeClaudeStopReadings(
      sink,
      stopCheck,
      {
        ran: null,
        stopped: { kind: 'literal', identity, body },
        reservedBytes: estimateStructuredAgentSessionItemBytes(identity, body)
      },
      { turnScope: endedTurnScope },
      { publish: false }
    )
  }
  if (terminalFailure && endedTurnIdentity) {
    writeClaudeTerminalFailure(sink, endedTurnIdentity, terminalFailure, stopCheck)
  }
  if (settlesTurn) {
    turn.suppressReopenOnFailure(message.is_error === true)
    corrections.abandon()
    streamedText.finish({ completedAt: observedAt })
    context.settle(
      message,
      commandResult?.end ?? claudeTurnEndForResult(message, observedAt),
      stopCheck && !commandResult
        ? { check: stopCheck, end: claudeTurnEndForResult(message, observedAt, true) }
        : undefined
    )
    streamedBlocks.clear()
    streamedText.settle()
  }
  const goal = threadGoal.settle(
    message,
    {
      backgroundWork: goalBackgroundWork(),
      stoppable: turnId !== null,
      turnStartedAt: endedTurnStartedAt
    },
    observedAt
  )
  if (goal) {
    journalClaudeGoal(sink, goal, turnId, observedAt, endedTurnScope)
  }
  const kind = claudeProviderFrameKind(message)
  const terminalShown = terminalFailure !== null && endedTurnIdentity !== null
  if (terminalShown && (!stopCheck || isSettledClaudeResultKind(kind))) {
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
        : corrections.stampFor(claudeFrameParentRef(message)),
      // Stopped, a known result kind needs no row; an unknown one keeps its plain disclosure.
      stopCheck && failure
        ? {
            check: stopCheck,
            ...(terminalShown ? { ran: null } : {}),
            stopped: isSettledClaudeResultKind(kind) ? null : { options: { reportsFailure: false } }
          }
        : undefined
    )
  }
}
