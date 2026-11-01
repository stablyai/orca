import { hookOutcomeRowBody } from '../../shared/agent-session-hook-outcome'
import type { AgentJournalPlainStatusItem } from '../../shared/agent-session-journal-types'

// Claude injects a blocking Stop hook's reason as a meta user turn; exit-2 hooks prefix it with their command.
const STOP_HOOK_FEEDBACK = /^Stop hook feedback:\n/

/** The row for Claude's injected Stop-hook feedback text, or null for any other text. */
export function claudeStopHookFeedbackRow(text: string): AgentJournalPlainStatusItem | null {
  if (!STOP_HOOK_FEEDBACK.test(text)) {
    return null
  }
  const reasons = text
    .replace(STOP_HOOK_FEEDBACK, '')
    .split('\n')
    .map((line) => line.replace(/^\[[^\]\n]+\]: /, ''))
  return hookOutcomeRowBody('sent-back', [reasons.join('\n')])
}
