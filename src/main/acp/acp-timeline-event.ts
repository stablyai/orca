import { createHash } from 'node:crypto'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat-subagent-summary'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'

export type AcpTimelineEvent = ProviderTimelineEvent & {
  /** Event-local identities in roster order, before display clipping; never journaled. */
  subagentIdentities?: readonly string[]
}

export function acpSubagentIdentity(providerId: string): string {
  return providerId.length <= MAX_SUBAGENT_FIELD_CHARS
    ? providerId
    : `acp-child:${createHash('sha256').update(providerId).digest('hex')}`
}
