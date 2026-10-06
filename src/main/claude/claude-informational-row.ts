// Only a `warning` frame (a UserPromptSubmit hook that blocked the prompt, say) earns a row, in its
// own words; `info`, `notice` (a hook's systemMessage) and `suggestion` are session chrome, not chat rows.

import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { claudeText } from './claude-structured-item-translation'

export const CLAUDE_INFORMATIONAL_FRAME_KIND = 'message:system:informational'

/** The row a warning-level note writes; null for every other level and for a warning with no words. */
export function claudeInformationalRowBody(
  message: Record<string, unknown>
): AgentJournalStatusItem | null {
  const text = message.level === 'warning' ? claudeText(message.content)?.trim() : null
  return text
    ? {
        kind: 'status',
        tone: 'warning',
        text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      }
    : null
}
