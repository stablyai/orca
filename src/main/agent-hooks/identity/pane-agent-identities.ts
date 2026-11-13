import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../../shared/wsl-hook-relay-contract'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { providerSessionLocatorIdentifies } from '../../../shared/agent-session/lifecycle/agent-provider-session-equality'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import { sameProviderKey, type AgentProviderKey } from './agent-provider-key'
import { AgentIdentityWorkerClient, type AgentIdentityClient } from './agent-identity-worker-client'
import { AgentIdentityDemand, type KeyDemand } from './agent-identity-demand'
import type { ReverseLookupUnavailable } from './agent-identity-worker-protocol'

/** Ids live on the hook server's own host, so the host column names "this host". */
const THIS_HOST = 'local'

export type ProviderSessionSighting = {
  agent: string | undefined
  providerSession: AgentProviderSessionMetadata | undefined
  /** Hook transport provenance; WSL relay rows name their distro, remote relays get no id. */
  connectionId: string | null
}

/** The provider key a hook row or sleeping record names, or null when it names none here. */
export function agentProviderKeyOf(sighting: ProviderSessionSighting): AgentProviderKey | null {
  const { agent, providerSession, connectionId } = sighting
  if (!agent || agent === 'unknown' || !providerSession?.id) {
    return null
  }
  let wslDistro = ''
  if (connectionId !== null) {
    if (!isWslHookRelayConnectionId(connectionId)) {
      return null
    }
    wslDistro = connectionId.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length)
  }
  return {
    executionHost: THIS_HOST,
    wslDistro,
    agent,
    providerSessionId: providerSession.id,
    locator: providerSessionLocatorIdentifies(agent) ? (providerSession.transcriptPath ?? '') : ''
  }
}

/** The provider conversation a status row names. */
export function agentSightingOf(row: {
  payload: { agentType?: string }
  providerSession?: AgentProviderSessionMetadata
  connectionId: string | null
}): ProviderSessionSighting {
  return {
    agent: row.payload.agentType,
    providerSession: row.providerSession,
    connectionId: row.connectionId
  }
}

/** A row's conversation id, computed when its provider key changes and copied at publication.
 *  `id` null: unresolved, either settled (a read-only file without this link) or `pending` (the
 *  worker has not answered yet, or failed; a later admission or Copy click asks again). */
export type RowAgentIdentity = {
  key: AgentProviderKey
  id: OrcaSessionId | null
  /** Not yet answered by the store: published as null so Copy stays offered and waits. */
  pending?: true
  /** The store authority that answered; an answer from a replaced store is never carried. */
  authority?: number
}

/** What a row publishes as `orcaSessionId`: its id; null while a failed link may still succeed
 *  (Copy retries); nothing for a settled read-only miss, where Copy could never succeed. */
export function publishedOrcaSessionId(
  identity: RowAgentIdentity | undefined
): string | null | undefined {
  return identity?.id ?? (identity?.pending ? null : undefined)
}

/** A place whose identity just changed (settled, or turned pending as its authority ended), for
 *  the hook server to re-stamp and publish. */
export type SettledAgentIdentityPlace = {
  place: string
  paneKey: string
  /** Set for a canonical (tmux-selected) subject; legacy places are status row keys. */
  canonicalSubject?: string
  identity: RowAgentIdentity
}

type IndexedPlace = { paneKey: string; identity: RowAgentIdentity; keyString: string }

/** Marks reverse-index places that are canonical (tmux) subjects, not legacy row keys. */
const CANONICAL_PLACE = '\u0001'

/** Names provider conversations for the hook server and indexes which rows carry each id.
 *  Admission stays synchronous: a new key is published pending and its row subscribes to one
 *  demand for that key; the demand's committed answer re-stamps the rows still waiting. */
export class PaneAgentIdentities {
  private readonly places = new Map<string, IndexedPlace>()
  private readonly placesById = new Map<string, Set<string>>()
  private readonly canonicalBySubject = new Map<string, RowAgentIdentity>()
  private readonly keyStrings = new WeakMap<AgentProviderKey, string>()
  private readonly demand: AgentIdentityDemand

  constructor(
    databasePath: () => string | null,
    private readonly onSettled: (places: SettledAgentIdentityPlace[]) => void,
    createClient: () => AgentIdentityClient = () => new AgentIdentityWorkerClient()
  ) {
    this.demand = new AgentIdentityDemand(
      databasePath,
      (demand, identity) => this.publish(demand, identity),
      createClient,
      () => this.invalidateSettled()
    )
  }

  /** Changes whenever the store authority ends; a caller compares it across its own awaits. */
  get generation(): number {
    return this.demand.generation
  }

  /** The current authority's token, synchronized first: take it before any fast path. */
  authority(): number {
    return this.demand.authority()
  }

  /** Whether `identity` is an answer of the current store authority. */
  isCurrent(identity: RowAgentIdentity): boolean {
    return identity.pending !== true && identity.authority === this.demand.generation
  }

  /** The identity a row carries: the carried one while its provider key is unchanged and it is
   *  not an ended authority's answer, the current demand's for the key, else a new pending one
   *  its admission subscribes to. The owner syncs the authority when its path changes, so
   *  admission never ends one. */
  assign(
    sighting: ProviderSessionSighting,
    carried: RowAgentIdentity | undefined
  ): RowAgentIdentity | undefined {
    const key = agentProviderKeyOf(sighting)
    if (!key) {
      return undefined
    }
    const sameKey = carried !== undefined && sameProviderKey(carried.key, key)
    if (sameKey && this.isCurrent(carried)) {
      return carried
    }
    // A carried pending row takes the key's settled answer, even one whose re-stamp was missed.
    return (
      this.demand.of(this.keyString(key))?.identity ??
      (sameKey && carried.pending === true ? carried : { key, id: null, pending: true })
    )
  }

  /** An explicit request (a Copy click): joins the key's demand, or sends it once during the
   *  failure backoff. Null when the store cannot name it within the wait. */
  async identify(sighting: ProviderSessionSighting): Promise<OrcaSessionId | null> {
    const key = agentProviderKeyOf(sighting)
    return key ? this.demand.identify(this.keyString(key), key) : null
  }

  /** Whether this host minted `id`; a miss in the live index asks the store, since a sleeping or
   *  closed conversation keeps its id. Undefined when the store cannot answer now. */
  async isTerminalIdentity(id: string): Promise<boolean | undefined> {
    const authority = this.authority()
    const known = this.placesById.has(id) ? true : await this.demand.has(id)
    return authority === this.demand.generation ? known : undefined
  }

  /** The provider conversation this host linked `id` to: `{ key: null }` for none, undefined
   *  when the store cannot answer now. An explicit lookup, never per hook. */
  async providerKeyOf(
    id: string
  ): Promise<{ key: AgentProviderKey | null } | ReverseLookupUnavailable | undefined> {
    return this.demand.lookup(`providerKeyOf\0${id}`, (client, path) =>
      client.providerKeyOf(path, id)
    )
  }

  async idsOfProviderSession(
    providerSessionId: string
  ): Promise<OrcaSessionId[] | ReverseLookupUnavailable | undefined> {
    return this.demand.lookup(`idsOfProviderSession\0${providerSessionId}`, (client, path) =>
      client.idsOfProviderSession(path, providerSessionId)
    )
  }

  /** Keeps the indexes and demand subscriptions exact: `place` is a legacy row key or a
   *  canonical subject. Admission subscribes here, after the row is stored. */
  setPlace(place: string, paneKey: string, identity: RowAgentIdentity | undefined): void {
    const previous = this.places.get(place)
    if (previous?.identity === identity && previous?.paneKey === paneKey) {
      return
    }
    if (previous) {
      if (previous.identity.id) {
        removeFrom(this.placesById, previous.identity.id, place)
      }
      this.places.delete(place)
      this.demand.unsubscribe(previous.keyString, place)
    }
    if (!identity) {
      return
    }
    const keyString = this.keyString(identity.key)
    this.places.set(place, { paneKey, identity, keyString })
    if (identity.id) {
      addTo(this.placesById, identity.id, place)
    }
    this.demand.subscribe(keyString, identity, place)
  }

  /** The rows carrying `id`: a legacy row key, or a canonical subject key with its pane. */
  placesOf(id: string): { key: string; paneKey: string; canonical: boolean }[] {
    return [...(this.placesById.get(id) ?? [])].map((place) => {
      const canonical = place.startsWith(CANONICAL_PLACE)
      return {
        key: canonical ? place.slice(CANONICAL_PLACE.length) : place,
        paneKey: this.places.get(place)?.paneKey ?? '',
        canonical
      }
    })
  }

  /** A canonical terminal status committed for `subjectKey`; called at its ingest only. */
  assignCanonical(
    subjectKey: string,
    paneKey: string,
    sighting: ProviderSessionSighting
  ): RowAgentIdentity | undefined {
    const identity = this.assign(sighting, this.canonicalBySubject.get(subjectKey))
    if (identity) {
      this.canonicalBySubject.set(subjectKey, identity)
    } else {
      this.canonicalBySubject.delete(subjectKey)
    }
    this.setPlace(`${CANONICAL_PLACE}${subjectKey}`, paneKey, identity)
    return identity
  }

  canonicalIdentity(subjectKey: string): RowAgentIdentity | undefined {
    return this.canonicalBySubject.get(subjectKey)
  }

  dropCanonical(subjectKey?: string): void {
    for (const key of subjectKey === undefined
      ? [...this.canonicalBySubject.keys()]
      : [subjectKey]) {
      this.canonicalBySubject.delete(key)
      this.setPlace(`${CANONICAL_PLACE}${key}`, '', undefined)
    }
  }

  /** Syncs the store authority; the owner calls it whenever its status path changes. */
  syncAuthority(): void {
    this.demand.syncAuthority()
  }

  close(): void {
    this.demand.close()
  }

  /** The store authority ended: its answers are void, so every place carrying one turns pending
   *  together (row, canonical subject and reverse index) and asks the next authority. */
  private invalidateSettled(): void {
    const invalidated: SettledAgentIdentityPlace[] = []
    // A re-indexed place is visited again, pending, and skipped.
    for (const [place, indexed] of this.places) {
      if (indexed.identity.pending) {
        continue
      }
      const identity = this.demand.of(indexed.keyString)?.identity ?? {
        key: indexed.identity.key,
        id: null,
        pending: true as const
      }
      const canonicalSubject = canonicalSubjectOf(place)
      if (canonicalSubject) {
        this.canonicalBySubject.set(canonicalSubject, identity)
      }
      this.setPlace(place, indexed.paneKey, identity)
      invalidated.push({ place, paneKey: indexed.paneKey, canonicalSubject, identity })
    }
    this.notify(invalidated)
  }

  /** Hands every current place still pending on the answered key to the hook server. An
   *  observer's failure is not the store's: the answer stays committed. */
  private publish(demand: KeyDemand, identity: RowAgentIdentity): void {
    const settled: SettledAgentIdentityPlace[] = []
    for (const place of demand.places) {
      const indexed = this.places.get(place)
      if (!indexed?.identity.pending) {
        continue
      }
      const canonicalSubject = canonicalSubjectOf(place)
      if (canonicalSubject) {
        this.canonicalBySubject.set(canonicalSubject, identity)
      }
      settled.push({ place, paneKey: indexed.paneKey, canonicalSubject, identity })
    }
    for (const { place, paneKey, canonicalSubject } of settled) {
      if (canonicalSubject) {
        this.setPlace(place, paneKey, identity)
      }
    }
    this.notify(settled)
  }

  private notify(places: SettledAgentIdentityPlace[]): void {
    if (places.length > 0) {
      try {
        this.onSettled(places)
      } catch (error) {
        console.error('[agent-hooks] agent identity publication failed', error)
      }
    }
  }

  private keyString(key: AgentProviderKey): string {
    let keyString = this.keyStrings.get(key)
    if (keyString === undefined) {
      keyString = [
        key.executionHost,
        key.wslDistro,
        key.agent,
        key.providerSessionId,
        key.locator
      ].join('\u0000')
      this.keyStrings.set(key, keyString)
    }
    return keyString
  }
}

function canonicalSubjectOf(place: string): string | undefined {
  return place.startsWith(CANONICAL_PLACE) ? place.slice(CANONICAL_PLACE.length) : undefined
}

function addTo(index: Map<string, Set<string>>, key: string, place: string): void {
  const places = index.get(key) ?? new Set<string>()
  places.add(place)
  index.set(key, places)
}

function removeFrom(index: Map<string, Set<string>>, key: string, place: string): void {
  const places = index.get(key)
  places?.delete(place)
  if (places?.size === 0) {
    index.delete(key)
  }
}
