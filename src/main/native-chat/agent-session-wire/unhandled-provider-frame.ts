import type { AgentJournalStatusItem } from '../../../shared/agent-session-journal-types'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from '../agent-session-journal/journal-payload-bounds'
import { classifyProviderFrame } from './provider-frame-disposition'

export type UnhandledProviderFrameJournalItem = {
  body: AgentJournalStatusItem
  /** Why the frame surfaced. Error frames are exempt from generic-row caps. */
  classification: 'timeline-substantive' | 'error-surface'
}

function serializeProviderPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload)
    return serialized === undefined ? String(payload) : serialized
  } catch (error) {
    return `[unserializable payload: ${error instanceof Error ? error.message : String(error)}]`
  }
}

/** Fields providers use for the human-facing sentence on a frame, most specific
 *  first. Nested one level because warnings arrive wrapped as often as not. */
const MESSAGE_KEYS = [
  'message',
  'text',
  'warning',
  'detail',
  'description',
  'reason',
  // `error` is how a failed dependency reports itself — an MCP server that could not start says
  // so here and nowhere else. Without it the row falls back to the bare method name, which is how
  // "MCP server X failed to start: auth expired" reached users as `notification:mcpServer/...`.
  'error'
] as const

function directReadableMessage(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload.trim() || null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

/** The provider's own sentence for a frame, when it carries one. */
export function readableProviderFrameText(payload: unknown): string | null {
  const direct = directReadableMessage(payload)
  if (direct || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return direct
  }
  const record = payload as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const nested = directReadableMessage(record[key])
    if (nested) {
      return nested
    }
  }
  return null
}

/** Substantive adapter fallbacks become visible, bounded journal rows. */
export function unhandledProviderFrameJournalItem(
  provider: string,
  kind: string,
  payload: unknown,
  limits: JournalPayloadLimits = DEFAULT_JOURNAL_PAYLOAD_LIMITS
): UnhandledProviderFrameJournalItem | null {
  const classification = classifyProviderFrame(provider, kind, payload)
  if (
    classification === 'stream-into-item' ||
    classification === 'status-chrome' ||
    classification === 'suppressed-benign'
  ) {
    return null
  }
  const serialized = serializeProviderPayload(payload)
  const bounded = boundPayload(serialized, limits)
  // Why: the opcode alone ("codex · notification:warning") tells the user nothing
  // and reads as protocol noise. Lead with the provider's own sentence when it has
  // one; the raw frame stays behind the row's disclosure either way.
  const method = kind.startsWith('notification:') ? kind.slice('notification:'.length) : kind
  const compaction =
    provider === 'codex' && (method === 'thread/compacted' || method === 'item:contextCompaction')
  const noticeTone =
    provider === 'codex'
      ? method === 'deprecationNotice'
        ? 'notice'
        : ['warning', 'guardianWarning', 'configWarning'].includes(method)
          ? 'warning'
          : undefined
      : undefined
  const tone = noticeTone ?? (classification === 'error-surface' ? 'error' : undefined)
  let message = readableProviderFrameText(payload)
  if (
    provider === 'codex' &&
    (method === 'configWarning' || method === 'deprecationNotice') &&
    typeof payload === 'object' &&
    payload !== null
  ) {
    const record = payload as Record<string, unknown>
    message =
      [record.summary, record.details]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n') || message
  }
  const display = message ? boundInlineText(message, limits) : null
  return {
    body: {
      kind: 'status',
      text: compaction ? 'Context compacted' : (display?.text ?? `${provider} · ${kind}`),
      ...(compaction ? { presentation: 'compaction' } : {}),
      ...(tone ? { tone } : {}),
      providerFrame: { provider, kind, payload: bounded }
    },
    classification: classification === 'error-surface' ? 'error-surface' : 'timeline-substantive'
  }
}
