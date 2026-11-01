import { hookOutcomeRowBody } from '../../shared/agent-session-hook-outcome'
import type { AgentJournalPlainStatusItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  claudeRecord,
  claudeText,
  type ClaudeMessageEnvelope
} from './structured/journal/claude-structured-item-translation'

// Claude injects a blocking Stop hook's reason as a meta user turn; exit-2 hooks prefix it with their command.
const STOP_HOOK_FEEDBACK = /^Stop hook feedback:\n/

/** The row for Claude's injected Stop-hook feedback text, or null for any other text. */
export function claudeStopHookFeedbackRow(text: string): AgentJournalPlainStatusItem | null {
  if (!STOP_HOOK_FEEDBACK.test(text)) {
    return null
  }
  const reason = text.replace(STOP_HOOK_FEEDBACK, '').replace(/^\[[^\]\n]+\]: /gm, '')
  return hookOutcomeRowBody('sent-back', [reason])
}

/** The same row from a root-agent envelope; it continues the turn, so importers must not treat it as a prompt. */
export function claudeEnvelopeStopHookFeedbackRow(
  envelope: ClaudeMessageEnvelope
): AgentJournalPlainStatusItem | null {
  const [part] = envelope.content
  const text = claudeText(claudeRecord(part)?.text)
  return envelope.isInjectedUserTurn &&
    envelope.parentToolUseId === null &&
    envelope.content.length === 1 &&
    text
    ? claudeStopHookFeedbackRow(text)
    : null
}
