// Only a `warning` frame earns a row: a prompt hook's outcome when it halts the prompt, else its own
// words; `info`, `notice` (a hook's systemMessage) and `suggestion` are session chrome, not chat rows.

import {
  hookOutcomeRowBody,
  type AgentSessionHookOutcome
} from '../../shared/agent-session-hook-outcome'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../shared/agent-session-turn-notice'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export const CLAUDE_INFORMATIONAL_FRAME_KIND = 'message:system:informational'

// `no_verdict` is Claude ending the prompt itself, not a hook's refusal: only its sentence is read.
const STRUCTURED_OUTCOMES = new Map<unknown, AgentSessionHookOutcome>([
  ['blocked_by_hook', 'blocked'],
  ['dropped_by_hook', 'blocked'],
  ['not_passed_on', 'blocked'],
  ['stopped_by_hook', 'stopped']
])
// Older Claude sends only its sentence: the hook's `[label]: ` and reason, then a copy of the prompt.
const SENTENCE_OUTCOMES: [RegExp, AgentSessionHookOutcome][] = [
  [/^\S+ operation blocked by hook:\s*/, 'blocked'],
  [/^Operation stopped by hook:?\s*/, 'stopped']
]

function hookOutcomeOf(message: Record<string, unknown>, text: string) {
  const structured = claudeRecord(message.prompt_submit_outcome)
  const outcome = STRUCTURED_OUTCOMES.get(structured?.kind)
  if (outcome) {
    return hookOutcomeRowBody(outcome, [claudeText(structured?.reason) ?? ''])
  }
  const sentence = SENTENCE_OUTCOMES.find(([prefix]) => prefix.test(text))
  if (!sentence) {
    return null
  }
  // The prompt copy goes first, so an empty reason never reads it as the reason.
  const [sentenceText = ''] = text.split(/\n+Original prompt:/)
  const reason = sentenceText.replace(sentence[0], '').replace(/^\[[^\]\n]+\]: /, '')
  return hookOutcomeRowBody(sentence[1], [reason])
}

/** The row a warning-level note writes; null for every other level and for a warning with no words. */
export function claudeInformationalRowBody(
  message: Record<string, unknown>
): AgentJournalStatusItem | null {
  const text = message.level === 'warning' ? claudeText(message.content)?.trim() : null
  if (!text) {
    return null
  }
  // A warning that halts the prompt is a hook's outcome, shown whether or not its words are known.
  const halts = message.prevent_continuation === true
  return (
    (halts ? hookOutcomeOf(message, text) : null) ?? {
      kind: 'status',
      tone: 'warning',
      text,
      ...(halts ? { presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION } : {})
    }
  )
}
