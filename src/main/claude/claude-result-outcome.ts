import type { AgentSessionTransientFailure } from '../../shared/agent-session-provider-retry-policy'
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

export function claudeTransientFailure(
  message: Record<string, unknown>
): AgentSessionTransientFailure | undefined {
  const code = message.api_error ?? message.error
  if (code !== undefined && code !== 'server_error' && code !== 'unknown') {
    return undefined
  }
  if (message.api_error_status === 529) {
    return 'overloaded'
  }
  if ([500, 502, 503, 504].includes(Number(message.api_error_status))) {
    return 'internal'
  }
  return code === 'server_error' ? 'internal' : undefined
}
