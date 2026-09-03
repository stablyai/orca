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
  blobs: { digest: string; payload: string }[]
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

function readableMessage(payload: unknown): string | null {
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
  const message = readableMessage(payload)
  const display = message ? boundInlineText(message, limits) : null
  return {
    body: {
      kind: 'status',
      text: display?.text ?? `${provider} · ${kind}`,
      providerFrame: { provider, kind, payload: bounded }
    },
    blobs: bounded.truncated ? [{ digest: bounded.digest, payload: serialized }] : [],
    classification: classification === 'error-surface' ? 'error-surface' : 'timeline-substantive'
  }
}
