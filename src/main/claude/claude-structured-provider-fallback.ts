import type {
  AgentJournalStatusItem,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { AgentSessionFailureRowWords } from '../../shared/agent-session-failure-words'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { PROVIDER_FRAME_PAYLOAD_LIMITS } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { CLAUDE_STREAM_JSON_FRAME_KINDS } from '../native-chat/agent-session-wire/claude-stream-json-frame-schema'
import {
  type UnhandledProviderFrameJournalItemOptions,
  readableProviderFrameText,
  unhandledProviderFrameJournalItem
} from '../native-chat/agent-session-wire/unhandled-provider-frame'
import {
  claudeRecord,
  claudeText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import { claudeResultOutcome } from './claude-result-outcome'
import type { ClaudeRowStamp } from './claude-provisional-row-corrections'
import {
  CLAUDE_API_RETRY_FRAME_KIND,
  claudeApiRetryRowBody,
  createClaudeApiRetryRuns
} from './claude-api-retry-row'
import {
  CLAUDE_INFORMATIONAL_FRAME_KIND,
  claudeInformationalRowBody
} from './claude-informational-row'

export function claudeProviderFrameKind(message: Record<string, unknown>): string {
  const type = claudeText(message.type) ?? 'unknown'
  const subtype = claudeText(message.subtype)
  const eventType = claudeText(claudeRecord(message.event)?.type)
  return ['message', type, subtype ?? eventType].filter(Boolean).join(':')
}

// Skip unjournaled telemetry: thinking tallies, unhandled stream deltas and pings.
const PROGRESS_FRAME_KINDS: ReadonlySet<string> = new Set([
  'message:system:thinking_tokens',
  'message:stream_event:content_block_delta',
  'message:stream_event:ping'
])

/** No row to write, so buffered output need not flush ahead of this frame. */
export function isClaudeProgressFrame(message: Record<string, unknown>): boolean {
  return PROGRESS_FRAME_KINDS.has(claudeProviderFrameKind(message))
}

const SETTLED_RESULT_KINDS: ReadonlySet<string> = new Set(
  CLAUDE_STREAM_JSON_FRAME_KINDS.filter((kind) => kind.startsWith('message:result:'))
)

/** Known results settle the turn directly; unknown subtypes need a fallback row. */
export function isSettledClaudeResultKind(kind: string): boolean {
  return SETTLED_RESULT_KINDS.has(kind)
}

/** API errors may use the success subtype; classify the outcome before suppressing a failure row. */
export function claudeResultFailure(
  message: Record<string, unknown>,
  leftToStop = false
): { text: string | null } | null {
  if (claudeResultOutcome(message, leftToStop) !== 'failure') {
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
  // Report failures even when the frame provides no readable explanation.
  return { text: errors.length > 0 ? errors.join('\n') : null }
}

/** Keep unknown wire kinds in disclosure, with readable placeholder text on the row. */
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
    // Local attachments replay with the base64 or file source Orca sent.
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
  acquisitionId: string,
  /** The frame's turn — the open one once `beforeAppend` ran — or the conversation. */
  turnScope: () => AgentJournalTurnScope
): {
  /** Override visible wording; a status body also supplies tone and failure facts. */
  append: (
    kind: string,
    payload: unknown,
    display?: string | null | (AgentSessionFailureRowWords & { tone: string }),
    /** Open a turn only if a row will be written. */
    beforeAppend?: () => void,
    options?: UnhandledProviderFrameJournalItemOptions,
    /** Attribute child output; omit for the session's own agent. */
    stamp?: ClaudeRowStamp
  ) => boolean
} {
  let sequence = 0
  const retryRun = createClaudeApiRetryRuns()
  return {
    append: (kind, payload, display, beforeAppend, options, stamp) => {
      sequence += 1
      const retrying = kind === CLAUDE_API_RETRY_FRAME_KIND ? claudeRecord(payload) : null
      if (retrying) {
        beforeAppend?.()
        // Revise one row per retry run.
        const identity = {
          provider: 'orca',
          clientMessageId: `provider-retry:claude:${acquisitionId}:${retryRun(retrying)}`
        } as const
        const body = claudeApiRetryRowBody(retrying)
        sink.appendItem(identity, body, stamp?.(identity, body) ?? { turnScope: turnScope() })
        sink.publish()
        return true
      }
      if (kind === CLAUDE_INFORMATIONAL_FRAME_KIND) {
        const body = claudeInformationalRowBody(claudeRecord(payload) ?? {})
        if (!body) {
          return false
        }
        beforeAppend?.()
        const identity = {
          provider: 'orca',
          clientMessageId: `provider-frame:claude:${acquisitionId}:${sequence}`
        } as const
        sink.appendItem(identity, body, stamp?.(identity, body) ?? { turnScope: turnScope() })
        sink.publish()
        return true
      }
      const translated = unhandledProviderFrameJournalItem(
        'claude',
        kind,
        payload,
        PROVIDER_FRAME_PAYLOAD_LIMITS,
        options
      )
      if (!translated) {
        return false
      }
      beforeAppend?.()
      const identity = {
        provider: 'orca',
        clientMessageId: `provider-frame:claude:${acquisitionId}:${sequence}`
      } as const
      const body: AgentJournalStatusItem =
        display && typeof display === 'object'
          ? { ...translated.body, ...display }
          : typeof display === 'string' && display
            ? { ...translated.body, text: display }
            : translated.body
      sink.appendItem(identity, body, stamp?.(identity, body) ?? { turnScope: turnScope() })
      sink.publish()
      return true
    }
  }
}

export type ClaudeProviderFrameFallback = ReturnType<typeof createClaudeProviderFrameFallback>

/** Journal unknown content and empty assistant frames; empty user replays have nothing to display. */
export function appendUnmodeledContent(
  fallback: ClaudeProviderFrameFallback,
  envelope: ClaudeMessageEnvelope,
  message: Record<string, unknown>,
  beforeAppend: () => void,
  stamp: ClaudeRowStamp
): boolean {
  let changed = false
  for (const part of envelope.content.filter((part) => !isModeledClaudeContent(part))) {
    const partType = claudeText(claudeRecord(part)?.type) ?? 'unknown'
    changed =
      fallback.append(
        `message:${envelope.role}:content:${partType}`,
        part,
        readableProviderFrameText(part) ?? CLAUDE_UNRENDERABLE_CONTENT_TEXT,
        beforeAppend,
        undefined,
        stamp
      ) || changed
  }
  if (envelope.content.length === 0 && envelope.role === 'assistant') {
    // Empty placeholders do not prove work began and may have no later result to close a turn.
    changed =
      fallback.append(
        `message:${envelope.role}:empty`,
        message,
        undefined,
        undefined,
        undefined,
        stamp
      ) || changed
  }
  return changed
}
