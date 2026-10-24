// Only warning-level informational frames belong on the chat timeline.

import {
  hookOutcomeRowBody,
  type AgentSessionHookOutcome
} from '../../shared/agent-session-hook-outcome'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../shared/agent-session-turn-notice'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export const CLAUDE_INFORMATIONAL_FRAME_KIND = 'message:system:informational'

// no_verdict is the CLI ending a prompt, so it uses the warning text instead of a hook outcome.
const STRUCTURED_OUTCOMES = new Map<unknown, AgentSessionHookOutcome>([
  ['blocked_by_hook', 'blocked'],
  ['dropped_by_hook', 'blocked'],
  ['not_passed_on', 'blocked'],
  ['stopped_by_hook', 'stopped']
])
// Older CLIs report hook outcomes as sentences followed by a prompt copy.
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
  // Remove the prompt copy before extracting a possibly empty reason.
  const [sentenceText = ''] = text.split(/\n+Original prompt:/)
  const reason = sentenceText.replace(sentence[0], '').replace(/^\[[^\]\n]+\]: /, '')
  return hookOutcomeRowBody(sentence[1], [reason])
}

export function claudeInformationalRowBody(
  message: Record<string, unknown>
): AgentJournalStatusItem | null {
  const text = message.level === 'warning' ? claudeText(message.content)?.trim() : null
  if (!text) {
    return null
  }
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
