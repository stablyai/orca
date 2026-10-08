// What a Claude result frame says became of the turn it ends.
//
// Sole owner of the abort-reason list. Two readers depend on that distinction —
// the turn's durable outcome and whether the failure earns a visible row — and a
// second copy of the list would drift into disagreeing about whether a stop was
// the user's or the provider's.

import type { AgentJournalTurnOutcome } from '../../shared/agent-session-journal-types'
import { claudeText } from './claude-structured-item-translation'

/** The SDK reports the user's stop as an error result, so `is_error` alone cannot
 *  tell a cancellation from a fault; only these reasons do. */
const CLAUDE_ABORTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools'])

/** A success-subtype result still carries `is_error` for an API error, so the flag
 *  is what decides, never the subtype. `leftToStop`: the journal's Stop rule makes this turn's end
 *  a person's cancellation (`personStopDecidesTurn`), so an error end with no abort reason gives no
 *  verdict (undefined): older CLIs name no reason, and that rule writes it with the end. */
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
