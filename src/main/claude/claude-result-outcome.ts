import type { AgentJournalTurnOutcome } from '../../shared/agent-session-journal-types'
import { claudeText } from './claude-structured-item-translation'

/** User stops are error results too; abort reasons distinguish cancellation from failure. */
const CLAUDE_ABORTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools'])

/** is_error overrides success subtypes; undefined defers error outcomes to the journal Stop rule. */
export function claudeResultOutcome(
  message: Record<string, unknown>,
  leftToStop = false
): AgentJournalTurnOutcome | undefined {
  if (message.is_error !== true) {
    return 'success'
  }
  const reason = claudeText(message.terminal_reason)
  if (reason !== null && CLAUDE_ABORTED_TERMINAL_REASONS.has(reason)) {
    return 'cancellation'
  }
  return leftToStop ? undefined : 'failure'
}
