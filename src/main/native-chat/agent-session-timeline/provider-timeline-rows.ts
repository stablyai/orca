// Derive row IDs from keys instead of maintaining an index; existing rows retain their original scope.

import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type {
  ProviderTimelineIdentityScheme,
  ProviderTimelineItemFamily,
  ProviderTimelineKey
} from './provider-timeline-identity'

export type ProviderTimelineRowId = { identity: AgentJournalItemIdentity; itemId: string }

export type ProviderTimelineTurnRef = ProviderTimelineRowId & {
  key: ProviderTimelineKey
  turnId: string
}

/** Reserve the widest possible request-incarnation suffix. */
const REQUEST_INCARNATION_BOUND = 1_000_000_000

export function providerKey(value: string): ProviderTimelineKey {
  return { source: 'provider', value }
}

export function turnOf(scope: AgentJournalTurnScope): string | null {
  return scope.kind === 'turn' ? scope.turnItemId : null
}

export class ProviderTimelineRows {
  constructor(
    private readonly deps: {
      scheme: ProviderTimelineIdentityScheme
      generation: string
      namespace: string
    }
  ) {}

  /** Consume acquisition-scoped serials only at admission. */
  minted(kind: string, serial: number): ProviderTimelineKey {
    return { source: 'minted', value: `${this.deps.generation}:${kind}${serial}` }
  }

  turn(key: ProviderTimelineKey): ProviderTimelineTurnRef {
    const address = { namespace: this.deps.namespace, key }
    const identity = this.deps.scheme.turn(address)
    return {
      key,
      identity,
      itemId: agentJournalItemKey(identity),
      turnId: this.deps.scheme.turnId(address)
    }
  }

  item(
    family: ProviderTimelineItemFamily,
    key: ProviderTimelineKey,
    thread: string | null
  ): ProviderTimelineRowId {
    return this.row(this.deps.scheme.item({ namespace: this.deps.namespace, family, key, thread }))
  }

  widestRequest(key: string): ProviderTimelineRowId {
    return this.request(key, REQUEST_INCARNATION_BOUND)
  }

  private request(key: string, incarnation: number): ProviderTimelineRowId {
    return this.row(
      this.deps.scheme.request({ generation: this.deps.generation, key, incarnation })
    )
  }

  private row(identity: AgentJournalItemIdentity): ProviderTimelineRowId {
    return { identity, itemId: agentJournalItemKey(identity) }
  }
}
