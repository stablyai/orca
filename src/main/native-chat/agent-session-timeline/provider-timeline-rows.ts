// Provider keys → journal rows, with no index to keep.
//
// Every row the assembler writes has an identity spelled from its key, so finding a row is
// spelling its id and reading that row: nothing to cache, evict or rebuild after a restart. The
// turn a row belongs to is the one the journal holds for it (its first write fixes it). Request
// incarnations are probed: the next is the first spelling the journal holds no row for.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type {
  ProviderTimelineIdentityScheme,
  ProviderTimelineItemFamily,
  ProviderTimelineKey
} from './provider-timeline-identity'

export type ProviderTimelineRowId = { identity: AgentJournalItemIdentity; itemId: string }

export type ProviderTimelineTurnRef = ProviderTimelineRowId & {
  key: ProviderTimelineKey
  /** The id the turn row carries and a client's Stop names. */
  turnId: string
}

export type ProviderTimelineTurnRowState = 'absent' | 'running' | 'settled'

type Journal = StructuredAgentSessionTransitionJournal

/** Room an item step reserves for a request id: the longest incarnation suffix it could take. */
const REQUEST_INCARNATION_BOUND = 1_000_000_000

export function providerKey(value: string): ProviderTimelineKey {
  return { source: 'provider', value }
}

export function turnOf(scope: AgentJournalTurnScope): string | null {
  return scope.kind === 'turn' ? scope.turnItemId : null
}

/** What the journal holds for a turn row: any writer's settlement (a person's Stop included). */
export function providerTimelineTurnRowState(
  journal: Journal,
  turnItemId: string
): ProviderTimelineTurnRowState {
  const row = readAgentJournalTurn(journal.itemBody(turnItemId) ?? undefined)
  return !row ? 'absent' : row.state === 'running' ? 'running' : 'settled'
}

export class ProviderTimelineRows {
  constructor(
    private readonly deps: {
      scheme: ProviderTimelineIdentityScheme
      generation: string
      namespace: string
    }
  ) {}

  /** A key unique to this acquisition; `serial` is taken from the state when the event is admitted. */
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

  /** The widest id a request under `key` could take, for the room its write reserves. */
  widestRequest(key: string): ProviderTimelineRowId {
    return this.request(key, REQUEST_INCARNATION_BOUND)
  }

  /** The first incarnation under `key` the journal holds no row for: never one already written. */
  nextRequest(key: string, journal: Journal): ProviderTimelineRowId {
    return this.request(key, this.heldIncarnations(key, journal) + 1)
  }

  /** The newest incarnation under `key` the journal holds, if any. */
  heldRequest(key: string, journal: Journal): ProviderTimelineRowId | null {
    const held = this.heldIncarnations(key, journal)
    return held === 0 ? null : this.request(key, held)
  }

  private heldIncarnations(key: string, journal: Journal): number {
    let held = 0
    while (journal.itemBody(this.request(key, held + 1).itemId) !== null) {
      held += 1
    }
    return held
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
