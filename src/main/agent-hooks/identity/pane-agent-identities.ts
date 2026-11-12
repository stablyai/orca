import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../../shared/wsl-hook-relay-contract'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { providerSessionLocatorIdentifies } from '../../../shared/agent-session/lifecycle/agent-provider-session-equality'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import { sameProviderKey, type AgentProviderKey } from './agent-provider-key'
import {
  AgentIdentityWorkerClient,
  type AgentIdentityClient,
  type AgentIdentityLookup
} from './agent-identity-worker-client'

const RETRY_DELAY_MS = 30_000

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
}

/** What a row publishes as `orcaSessionId`: its id; null while a failed link may still succeed
 *  (Copy retries); nothing for a settled read-only miss, where Copy could never succeed. */
export function publishedOrcaSessionId(
  identity: RowAgentIdentity | undefined
): string | null | undefined {
  return identity?.id ?? (identity?.pending ? null : undefined)
}

/** A place whose pending identity just settled, for the hook server to re-stamp and publish. */
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
 *  Admission stays synchronous: a new key is published pending and resolved once, off-thread, by
 *  the identity worker; its committed answer then re-stamps every current row naming that key. */
export class PaneAgentIdentities {
  private client: AgentIdentityClient | null = null
  private clientPath: string | null = null
  /** Bumped when the store authority changes; a reply from an older one stamps nothing. */
  private generation = 0
  /** After a failed answer no background request is sent before this; a click still is. */
  private retryAt = 0
  private failing = false
  private readonly places = new Map<string, IndexedPlace>()
  private readonly placesById = new Map<string, Set<string>>()
  private readonly placesByKey = new Map<string, Set<string>>()
  private readonly canonicalBySubject = new Map<string, RowAgentIdentity>()
  /** One request per exact key, shared by every row, pane and click waiting on it. */
  private readonly demands = new Map<string, Promise<AgentIdentityLookup>>()
  private readonly keyStrings = new WeakMap<AgentProviderKey, string>()

  constructor(
    private readonly databasePath: () => string | null,
    private readonly onSettled: (places: SettledAgentIdentityPlace[]) => void,
    private readonly createClient: () => AgentIdentityClient = () => new AgentIdentityWorkerClient()
  ) {}

  /** The identity a row carries: the carried one while its provider key is unchanged, a current
   *  row's settled answer for the same key, else pending while the worker resolves it. */
  assign(
    sighting: ProviderSessionSighting,
    carried: RowAgentIdentity | undefined
  ): RowAgentIdentity | undefined {
    const key = agentProviderKeyOf(sighting)
    if (!key) {
      return undefined
    }
    if (carried && sameProviderKey(carried.key, key)) {
      if (carried.pending) {
        void this.demand(carried.key, false)
      }
      return carried
    }
    const settled = this.settledFor(this.keyString(key))
    if (settled) {
      return settled
    }
    void this.demand(key, false)
    return { key, id: null, pending: true }
  }

  /** An explicit request (a Copy click): joins pending work, or tries once during the backoff. */
  async identify(sighting: ProviderSessionSighting): Promise<OrcaSessionId | null> {
    const key = agentProviderKeyOf(sighting)
    if (!key) {
      return null
    }
    const settled = this.settledFor(this.keyString(key))
    if (settled) {
      return settled.id
    }
    return (await this.demand(key, true))?.id ?? null
  }

  /** Whether this host minted `id`; a miss in the live index asks the store, since a sleeping or
   *  closed conversation keeps its id. Undefined when the store cannot answer. */
  async isTerminalIdentity(id: string): Promise<boolean | undefined> {
    if (this.placesById.has(id)) {
      return true
    }
    const path = this.databasePath()
    return path ? this.currentClient(path).has(path, id) : undefined
  }

  /** Keeps both indexes exact: `place` is a legacy row key or a canonical subject. */
  setPlace(place: string, paneKey: string, identity: RowAgentIdentity | undefined): void {
    const previous = this.places.get(place)
    if (previous?.identity === identity && previous?.paneKey === paneKey) {
      return
    }
    if (previous) {
      removeFrom(this.placesByKey, previous.keyString, place)
      if (previous.identity.id) {
        removeFrom(this.placesById, previous.identity.id, place)
      }
      this.places.delete(place)
    }
    if (!identity) {
      return
    }
    const keyString = this.keyString(identity.key)
    this.places.set(place, { paneKey, identity, keyString })
    addTo(this.placesByKey, keyString, place)
    if (identity.id) {
      addTo(this.placesById, identity.id, place)
    }
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

  close(): void {
    this.client?.dispose()
    this.client = null
    this.clientPath = null
    this.generation++
    this.demands.clear()
    this.retryAt = 0
  }

  private demand(key: AgentProviderKey, explicit: boolean): Promise<AgentIdentityLookup> {
    const keyString = this.keyString(key)
    const inFlight = this.demands.get(keyString)
    if (inFlight) {
      return inFlight
    }
    const path = this.databasePath()
    if (!path || (!explicit && Date.now() < this.retryAt)) {
      return Promise.resolve(undefined)
    }
    const client = this.currentClient(path)
    // Read after currentClient: switching stores closes the old one and bumps the generation.
    const generation = this.generation
    const request: Promise<AgentIdentityLookup> = client.identify(path, key).then((answer) => {
      if (this.demands.get(keyString) === request) {
        this.demands.delete(keyString)
      }
      if (generation !== this.generation) {
        return undefined
      }
      if (!answer) {
        this.retryAt = Date.now() + RETRY_DELAY_MS
        if (!this.failing) {
          console.warn('[agent-hooks] agent identities unavailable; retrying after a delay')
        }
        this.failing = true
        return undefined
      }
      this.failing = false
      this.settle(keyString, { key, id: answer.id })
      return answer
    })
    this.demands.set(keyString, request)
    return request
  }

  /** Hands every current place still pending on this key to the hook server to re-stamp. */
  private settle(keyString: string, identity: RowAgentIdentity): void {
    const settled: SettledAgentIdentityPlace[] = []
    for (const place of this.placesByKey.get(keyString) ?? []) {
      const indexed = this.places.get(place)
      if (!indexed?.identity.pending) {
        continue
      }
      if (place.startsWith(CANONICAL_PLACE)) {
        const canonicalSubject = place.slice(CANONICAL_PLACE.length)
        this.canonicalBySubject.set(canonicalSubject, identity)
        settled.push({ place, paneKey: indexed.paneKey, canonicalSubject, identity })
      } else {
        settled.push({ place, paneKey: indexed.paneKey, identity })
      }
    }
    for (const { place, paneKey, canonicalSubject } of settled) {
      if (canonicalSubject) {
        this.setPlace(place, paneKey, identity)
      }
    }
    if (settled.length > 0) {
      this.onSettled(settled)
    }
  }

  private settledFor(keyString: string): RowAgentIdentity | undefined {
    for (const place of this.placesByKey.get(keyString) ?? []) {
      const identity = this.places.get(place)?.identity
      if (identity && !identity.pending) {
        return identity
      }
    }
    return undefined
  }

  private currentClient(path: string): AgentIdentityClient {
    if (path !== this.clientPath) {
      this.close()
      this.clientPath = path
    }
    this.client ??= this.createClient()
    return this.client
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
