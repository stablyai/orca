import type { AgentJournalTurnOutcome } from '../../../../shared/agent-status/lifecycle/agent-turn-outcome'
import { claudeText } from '../journal/claude-structured-item-translation'

/** User stops are error results too; abort reasons distinguish cancellation from failure. */
const CLAUDE_ABORTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools'])

/** A step Claude cut short; a steer's interrupt reports one with is_error false. */
export function claudeResultEndedStepEarly(message: Record<string, unknown>): boolean {
  const reason = claudeText(message.terminal_reason)
  return reason !== null && CLAUDE_ABORTED_TERMINAL_REASONS.has(reason)
}

/** is_error overrides success subtypes; undefined defers error outcomes to the journal Stop rule. */
export function claudeResultOutcome(
  message: Record<string, unknown>,
  leftToStop = false
): AgentJournalTurnOutcome | undefined {
  if (claudeResultEndedStepEarly(message)) {
    return 'cancellation'
  }
  if (message.is_error !== true) {
    return 'success'
  }
  return leftToStop ? undefined : 'failure'
}
