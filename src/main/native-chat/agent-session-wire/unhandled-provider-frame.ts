import type { AgentJournalStatusItem } from '../../../shared/agent-session-journal-types'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from '../agent-session-journal/journal-payload-bounds'
import { classifyProviderFrame } from './provider-frame-disposition'

export type UnhandledProviderFrameJournalItem = {
  body: AgentJournalStatusItem
  blobs: { digest: string; payload: string }[]
}

function serializeProviderPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload)
    return serialized === undefined ? String(payload) : serialized
  } catch (error) {
    return `[unserializable payload: ${error instanceof Error ? error.message : String(error)}]`
  }
}

/** Substantive adapter fallbacks become visible, bounded journal rows. */
export function unhandledProviderFrameJournalItem(
  provider: string,
  kind: string,
  payload: unknown,
  limits: JournalPayloadLimits = DEFAULT_JOURNAL_PAYLOAD_LIMITS
): UnhandledProviderFrameJournalItem | null {
  const classification = classifyProviderFrame(provider, kind, payload)
  if (classification === 'status-chrome' || classification === 'suppressed-benign') {
    return null
  }
  const serialized = serializeProviderPayload(payload)
  const bounded = boundPayload(serialized, limits)
  return {
    body: {
      kind: 'status',
      text: `${provider} · ${kind}`,
      providerFrame: { provider, kind, payload: bounded }
    },
    blobs: bounded.truncated ? [{ digest: bounded.digest, payload: serialized }] : []
  }
}
