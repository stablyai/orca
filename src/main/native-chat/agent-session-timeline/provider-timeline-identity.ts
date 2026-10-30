// Pure identity spelling preserves existing legacy shapes; the assembler decides row equivalence.

import type {
  AgentJournalItemIdentity,
  AgentType
} from '../../../shared/agent-session-journal-types'
import { boundPayload, digestPayload } from '../agent-session-journal/journal-payload-bounds'

/** Minted keys are acquisition-unique and need no provider namespace. */
export type ProviderTimelineKey = { source: 'provider' | 'minted'; value: string }

/** Text and snapshots share item identities; fallback frames use a separate key space. */
export type ProviderTimelineItemFamily = 'item' | 'frame'

export type ProviderTimelineTurnAddress = {
  namespace: string
  key: ProviderTimelineKey
}

export type ProviderTimelineItemAddress = ProviderTimelineTurnAddress & {
  family: ProviderTimelineItemFamily
  thread: string | null
}

/** Scope request IDs to acquisitions because provider processes reuse JSON-RPC IDs. */
export type ProviderTimelineRequestAddress = {
  generation: string
  key: string
  /** Increment when the same request key is reused within an acquisition. */
  incarnation: number
}

export type ProviderTimelineIdentityScheme = {
  turn(address: ProviderTimelineTurnAddress): AgentJournalItemIdentity
  /** Client Stops name this ID. */
  turnId(address: ProviderTimelineTurnAddress): string
  item(address: ProviderTimelineItemAddress): AgentJournalItemIdentity
  request(address: ProviderTimelineRequestAddress): AgentJournalItemIdentity
}

const MAX_KEY_PART_BYTES = 256

/** Escape separators and digest long IDs to prevent forged parts or shared-prefix collisions. */
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

export function spellProviderTimelineKey(
  namespace: string,
  key: ProviderTimelineKey,
  thread: string | null = null
): string {
  // Item IDs are unique only within each provider thread.
  const scope = thread === null ? '' : `${providerTimelineKeyPart(thread)}/`
  return key.source === 'provider'
    ? `p:${providerTimelineKeyPart(namespace)}:${scope}${providerTimelineKeyPart(key.value)}`
    : `m:${providerTimelineKeyPart(key.value)}`
}

export function isProviderTimelineTurnInNamespace(turnId: string, namespace: string): boolean {
  return turnId.startsWith(`p:${providerTimelineKeyPart(namespace)}:`)
}

export { spelledProviderTimelineItemKey } from '../../../shared/provider-timeline-item-key'

/** Preserve legacy turn-lifecycle prefixes and separate provider namespaces from minted keys. */
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
