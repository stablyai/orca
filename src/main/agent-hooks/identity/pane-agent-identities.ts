import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../../shared/wsl-hook-relay-contract'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { providerSessionLocatorIdentifies } from '../../../shared/agent-session/lifecycle/agent-provider-session-equality'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import { AgentIdentityStore, type AgentProviderKey } from './agent-identity-store'

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
 *  `id` null: unresolved (a read-only file without this link, or a pending failed lookup); the
 *  row is still published as one this host can name, so a Copy click can retry. */
export type RowAgentIdentity = {
  key: AgentProviderKey
  id: OrcaSessionId | null
  /** The store was unavailable: not settled, so a later admission resolves it again. */
  pending?: true
}

export type AgentIdentityStoreHandle = Pick<
  AgentIdentityStore,
  'identify' | 'has' | 'close' | 'readOnly'
>

type IdentifyResult =
  | { kind: 'id'; id: OrcaSessionId }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

/** Runtime-only marker for indexed rows that are canonical (tmux) statuses, not legacy rows. */
const CANONICAL_PLACE = '\u0001'

/** Names provider conversations for the hook server and indexes which rows carry each id. */
export class PaneAgentIdentities {
  private store: AgentIdentityStoreHandle | null = null
  private storePath: string | null = null
  /** After an open or write failure no SQLite work is tried before this, except by a click. */
  private retryAt = 0
  private failing = false
  private readonly placeById = new Map<string, { paneKey: string; id: OrcaSessionId }>()
  private readonly placesById = new Map<string, Set<string>>()
  private readonly canonicalBySubject = new Map<string, RowAgentIdentity>()

  constructor(
    private readonly databasePath: () => string | null,
    private readonly openStore: (path: string) => AgentIdentityStoreHandle = (path) =>
      new AgentIdentityStore(path)
  ) {}

  /** The identity a row carries: the carried one while its provider key is unchanged, else a
   *  store resolution. Undefined when the row names no key here; `pending` when the store was
   *  unavailable, so the next admission (after the backoff) or a Copy click retries. */
  assign(
    sighting: ProviderSessionSighting,
    carried: RowAgentIdentity | undefined
  ): RowAgentIdentity | undefined {
    const key = agentProviderKeyOf(sighting)
    if (!key) {
      return undefined
    }
    if (carried && carried.pending !== true && sameProviderKey(carried.key, key)) {
      return carried
    }
    const result = this.resolve(key, false)
    return result.kind === 'id'
      ? { key, id: result.id }
      : result.kind === 'absent'
        ? { key, id: null }
        : { key, id: null, pending: true }
  }

  /** An explicit request (a Copy click): one attempt even during a failure backoff. */
  identify(sighting: ProviderSessionSighting): OrcaSessionId | null {
    const key = agentProviderKeyOf(sighting)
    const result = key ? this.resolve(key, true) : null
    return result?.kind === 'id' ? result.id : null
  }

  /** Whether this host minted `id` for a terminal conversation. */
  isTerminalIdentity(id: string): boolean {
    if (this.placesById.has(id)) {
      return true
    }
    return this.withStore(false, (store) => store.has(id)) === true
  }

  /** Keeps the reverse index exact: `place` is a legacy row key or a canonical subject. */
  setPlace(place: string, paneKey: string, identity: RowAgentIdentity | undefined): void {
    const previous = this.placeById.get(place)
    if (previous) {
      const places = this.placesById.get(previous.id)
      places?.delete(place)
      if (places?.size === 0) {
        this.placesById.delete(previous.id)
      }
      this.placeById.delete(place)
    }
    if (!identity?.id) {
      return
    }
    this.placeById.set(place, { paneKey, id: identity.id })
    const places = this.placesById.get(identity.id) ?? new Set<string>()
    places.add(place)
    this.placesById.set(identity.id, places)
  }

  /** The rows carrying `id`: a legacy row key, or a canonical subject key with its pane. */
  placesOf(id: string): { key: string; paneKey: string; canonical: boolean }[] {
    return [...(this.placesById.get(id) ?? [])].map((place) => {
      const canonical = place.startsWith(CANONICAL_PLACE)
      return {
        key: canonical ? place.slice(CANONICAL_PLACE.length) : place,
        paneKey: this.placeById.get(place)?.paneKey ?? '',
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
    this.store?.close()
    this.store = null
    this.storePath = null
    this.retryAt = 0
  }

  private resolve(key: AgentProviderKey, explicit: boolean): IdentifyResult {
    const id = this.withStore(explicit, (store) => store.identify(key))
    return id === undefined ? { kind: 'unavailable' } : id ? { kind: 'id', id } : { kind: 'absent' }
  }

  /** Undefined when the store is unavailable or failed; a failure starts the retry delay. */
  private withStore<T>(
    explicit: boolean,
    read: (store: AgentIdentityStoreHandle) => T
  ): T | undefined {
    if (!explicit && Date.now() < this.retryAt) {
      return undefined
    }
    const store = this.currentStore()
    if (!store) {
      return undefined
    }
    try {
      const result = read(store)
      this.failing = false
      return result
    } catch (error) {
      this.retryAt = Date.now() + RETRY_DELAY_MS
      this.reportFailure(error)
      return undefined
    }
  }

  private currentStore(): AgentIdentityStoreHandle | null {
    const path = this.databasePath()
    if (path !== this.storePath) {
      this.close()
      this.storePath = path
    }
    if (!path || this.store) {
      return this.store
    }
    try {
      this.store = this.openStore(path)
    } catch (error) {
      this.retryAt = Date.now() + RETRY_DELAY_MS
      this.reportFailure(error)
    }
    return this.store
  }

  private reportFailure(error: unknown): void {
    if (!this.failing) {
      console.warn('[agent-hooks] agent identity store unavailable:', error)
    }
    this.failing = true
  }
}

function sameProviderKey(left: AgentProviderKey, right: AgentProviderKey): boolean {
  return (
    left.providerSessionId === right.providerSessionId &&
    left.agent === right.agent &&
    left.wslDistro === right.wslDistro &&
    left.locator === right.locator &&
    left.executionHost === right.executionHost
  )
}
