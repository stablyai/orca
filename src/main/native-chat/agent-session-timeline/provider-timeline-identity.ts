// How the assembler's keys become persisted journal identities.
//
// The assembler decides WHICH rows are the same row; a scheme only spells them. It must be pure,
// and it is the one place a provider's persisted identity shape lives. Every provider on the
// assembler spells its rows in the existing `legacy` arm, so no row shape is new.

import type {
  AgentJournalItemIdentity,
  AgentType
} from '../../../shared/agent-session-journal-types'
import { boundPayload, digestPayload } from '../agent-session-journal/journal-payload-bounds'

/** A key the provider vouched for, or one the assembler minted because it named nothing.
 *  A minted value is unique per acquisition, so it never needs a namespace. */
export type ProviderTimelineKey = { source: 'provider' | 'minted'; value: string }

/** Streamed text and full item snapshots share `item`, so a provider-named message is one row
 *  however it arrives; fallback frames never share its key space. */
export type ProviderTimelineItemFamily = 'item' | 'frame'

export type ProviderTimelineTurnAddress = {
  /** The provider session whose ids the key belongs to. */
  namespace: string
  key: ProviderTimelineKey
}

export type ProviderTimelineItemAddress = ProviderTimelineTurnAddress & {
  family: ProviderTimelineItemFamily
  /** The provider thread it came from; null when the provider named none. */
  thread: string | null
}

/** A question the provider asked under its request id. JSON-RPC ids restart with each provider
 *  process, so a request is spelled in the acquisition that asked it. */
export type ProviderTimelineRequestAddress = {
  generation: string
  key: string
  /** 1 for the first request under the key in this acquisition; a reused key takes the next. */
  incarnation: number
}

export type ProviderTimelineIdentityScheme = {
  turn(address: ProviderTimelineTurnAddress): AgentJournalItemIdentity
  /** The id the turn row carries and a client's Stop names. */
  turnId(address: ProviderTimelineTurnAddress): string
  item(address: ProviderTimelineItemAddress): AgentJournalItemIdentity
  request(address: ProviderTimelineRequestAddress): AgentJournalItemIdentity
}

const MAX_KEY_PART_BYTES = 256

/** A provider id as a bounded identity part: escaped so `:` cannot forge another part, and
 *  digest-suffixed when long so two long ids never share a prefix-only spelling. */
export function providerTimelineKeyPart(value: string): string {
  const encoded = encodeURIComponent(value)
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_KEY_PART_BYTES) {
    return encoded
  }
  const suffix = `#${digestPayload(value).slice(0, 24)}`
  const head = boundPayload(encoded, {
    inlineHeadBytes: MAX_KEY_PART_BYTES - Buffer.byteLength(suffix, 'utf8')
  }).head
  return `${head}${suffix}`
}

/** A key as one bounded string inside its namespace (and thread, for a per-thread key). */
export function spellProviderTimelineKey(
  namespace: string,
  key: ProviderTimelineKey,
  thread: string | null = null
): string {
  // A provider's item ids are its own per thread, so a subagent thread's ids are spelled apart.
  const scope = thread === null ? '' : `${providerTimelineKeyPart(thread)}/`
  return key.source === 'provider'
    ? `p:${providerTimelineKeyPart(namespace)}:${scope}${providerTimelineKeyPart(key.value)}`
    : `m:${providerTimelineKeyPart(key.value)}`
}

/** Whether a turn id names a turn the provider keyed inside session `namespace`. */
export function isProviderTimelineTurnInNamespace(turnId: string, namespace: string): boolean {
  return turnId.startsWith(`p:${providerTimelineKeyPart(namespace)}:`)
}

export { spelledProviderTimelineItemKey } from '../../../shared/provider-timeline-item-key'

/** The existing `legacy` arm. Turn rows keep the `turn-lifecycle:` record prefix the other lanes
 *  write; provider keys are spelled inside their namespace, and apart from minted ones. */
export function createLegacyProviderTimelineIdentityScheme(input: {
  agent: AgentType
  sessionId: string
}): ProviderTimelineIdentityScheme {
  const identity = (recordId: string): AgentJournalItemIdentity => ({
    provider: 'legacy',
    agent: input.agent,
    sessionId: input.sessionId,
    recordId
  })
  return {
    turn: (address) =>
      identity(`turn-lifecycle:${spellProviderTimelineKey(address.namespace, address.key)}`),
    turnId: (address) => spellProviderTimelineKey(address.namespace, address.key),
    item: (address) =>
      identity(
        `${address.family}:${spellProviderTimelineKey(address.namespace, address.key, address.thread)}`
      ),
    request: (address) =>
      identity(
        `request:g:${providerTimelineKeyPart(address.generation)}:${providerTimelineKeyPart(address.key)}${
          address.incarnation > 1 ? `#${address.incarnation}` : ''
        }`
      )
  }
}
