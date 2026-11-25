// A local slash command's reply (e.g. /recap) persists as a system row but streamed as a synthetic
// assistant frame with the same uuid; restore it in that shape so replay matches what the live chat showed.

import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import { localCommandStdoutText } from '../../../shared/native-chat/tools/native-chat-command-output'
import { claudeText } from '../structured/journal/claude-structured-item-translation'
import { claudeMessageWithoutSyntheticText } from '../structured/journal/claude-internal-message-content'

/**
 * Only reporting commands like /recap replay; effect-only feedback (/model, /color) stays hidden.
 * Gated here rather than in the slash catalog so older CLIs are not offered /recap.
 */
export function claudeLocalCommandReplyText(row: Record<string, unknown>): string | null {
  return row.type === 'system' &&
    row.subtype === 'local_command' &&
    asRecord(row.commandRun)?.command === 'recap'
    ? localCommandStdoutText(claudeText(row.content) ?? '')
    : null
}

/** The live stream frame a saved transcript row replays as; restore and catch-up keys must agree. */
export function claudeTranscriptRowFrame(
  row: Record<string, unknown>
): Record<string, unknown> | null {
  const frame = { ...row, session_id: row.sessionId, parent_tool_use_id: null }
  const text = claudeLocalCommandReplyText(row)
  return claudeMessageWithoutSyntheticText(
    text
      ? {
          ...frame,
          type: 'assistant',
          message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }
        }
      : frame
  )
}
