import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { CLAUDE_STREAM_JSON_FRAME_KINDS } from '../native-chat/agent-session-wire/claude-stream-json-frame-schema'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export function claudeProviderFrameKind(message: Record<string, unknown>): string {
  const type = claudeText(message.type) ?? 'unknown'
  const subtype = claudeText(message.subtype)
  const eventType = claudeText(claudeRecord(message.event)?.type)
  return ['message', type, subtype ?? eventType].filter(Boolean).join(':')
}

const SETTLED_RESULT_KINDS: ReadonlySet<string> = new Set(
  CLAUDE_STREAM_JSON_FRAME_KINDS.filter((kind) => kind.startsWith('message:result:'))
)

/** A catalogued result subtype is the turn-complete signal the translator settles
 *  itself; only an unmodeled subtype still needs the provider-fallback row. */
export function isSettledClaudeResultKind(kind: string): boolean {
  return SETTLED_RESULT_KINDS.has(kind)
}

/**
 * The failure a result frame carries that the turn's own frames never showed.
 *
 * Suppression is by meaning, not by kind. The SDK models an API failure as a
 * SUCCESS-subtype result whose `result` string IS the error text and which has
 * no assistant frame behind it, so keying on the subtype tombstones the turn and
 * shows the user a completed, empty reply. A turn the user aborted is the
 * opposite: its interrupt frame already says so, and the diagnostic in `errors`
 * would only be noise.
 */
export function claudeResultFailure(
  message: Record<string, unknown>
): { text: string | null } | null {
  if (message.is_error !== true) {
    return null
  }
  const terminalReason = claudeText(message.terminal_reason)
  if (terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools') {
    return null
  }
  const result = claudeText(message.result)?.trim()
  if (result) {
    return { text: result }
  }
  const errors = Array.isArray(message.errors)
    ? message.errors.flatMap((entry) => {
        const text = claudeText(entry)?.trim()
        return text ? [text] : []
      })
    : []
  // Nothing readable to lead with, but a reported failure still gets its row.
  return { text: errors.length > 0 ? errors.join('\n') : null }
}

/**
 * What a message part that Orca cannot render says for itself. The kinds under
 * `message:<role>:content:*` are synthesised from whatever `part.type` the CLI
 * sends, so they can never be catalogued ahead of time; printing one is leaking
 * wire vocabulary at a user who cannot act on it. The frame stays on the row's
 * disclosure, so nothing is dropped and the next reader can still name it.
 */
export const CLAUDE_UNRENDERABLE_CONTENT_TEXT = 'Claude sent content Orca cannot display yet'

export function isModeledClaudeContent(value: unknown): boolean {
  const part = claudeRecord(value)
  if (!part) {
    return false
  }
  if (part.type === 'text') {
    return claudeText(part.text) !== null
  }
  if (part.type === 'image') {
    const source = claudeRecord(part.source)
    if (source?.type === 'url') {
      return claudeText(source.url) !== null
    }
    // A local attachment is replayed as the base64 (or file) source Orca itself
    // sent, so it is content we recognise -- not an unknown part to surface.
    return source?.type === 'base64' || source?.type === 'file'
  }
  if (part.type === 'tool_use') {
    return claudeText(part.id) !== null && claudeText(part.name) !== null
  }
  if (part.type === 'tool_result') {
    return claudeText(part.tool_use_id) !== null
  }
  // Redacted thinking arrives as an empty string plus a signature.
  return part.type === 'thinking' || part.type === 'redacted_thinking'
}

export function createClaudeProviderFrameFallback(
  sink: StructuredAgentSessionEventSink,
  acquisitionId: string
): {
  /** `displayText` leads the row when Claude knows the sentence the frame itself does not name. */
  append: (kind: string, payload: unknown, displayText?: string | null) => void
} {
  let sequence = 0
  return {
    append: (kind, payload, displayText) => {
      sequence += 1
      const translated = unhandledProviderFrameJournalItem('claude', kind, payload)
      if (!translated) {
        return
      }
      const bounded = displayText
        ? boundInlineText(displayText, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
        : null
      sink.appendItem(
        {
          provider: 'orca',
          clientMessageId: `provider-frame:claude:${acquisitionId}:${sequence}`
        },
        bounded ? { ...translated.body, text: bounded } : translated.body
      )
      sink.publish()
    }
  }
}
