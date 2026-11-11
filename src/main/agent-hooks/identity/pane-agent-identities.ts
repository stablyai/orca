import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../../shared/wsl-hook-relay-contract'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { providerSessionLocatorIdentifies } from '../../../shared/agent-session/lifecycle/agent-provider-session-equality'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import { AgentIdentityStore, type AgentProviderKey } from './agent-identity-store'

const MAX_CACHED_PANES = 1024
const REOPEN_DELAY_MS = 30_000

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

type PublishedAgentRow = {
  paneKey: string
  connectionId: string | null
  structuredHost?: unknown
  providerSession?: AgentProviderSessionMetadata
  payload: { agentType?: string }
  orcaSessionId?: string
}

/** Names each pane's provider conversation; the store is read only when a pane's key changes. */
export class PaneAgentIdentities {
  private store: AgentIdentityStore | null = null
  private storePath: string | null = null
  private reopenAt = 0
  private failing = false
  private readonly byPaneKey = new Map<string, { key: string; id: OrcaSessionId }>()

  constructor(private readonly databasePath: () => string | null) {}

  /** The conversation's id, minted on first sighting; null when it names none here or until a
   *  commit succeeds. */
  identify(sighting: ProviderSessionSighting, paneKey?: string): OrcaSessionId | null {
    const key = agentProviderKeyOf(sighting)
    if (!key) {
      return null
    }
    const cacheKey = JSON.stringify(key)
    const cached = paneKey === undefined ? undefined : this.byPaneKey.get(paneKey)
    if (cached?.key === cacheKey) {
      return cached.id
    }
    const id = this.withStore((store) => store.identify(key))
    if (id && paneKey !== undefined) {
      this.byPaneKey.delete(paneKey)
      this.byPaneKey.set(paneKey, { key: cacheKey, id })
      if (this.byPaneKey.size > MAX_CACHED_PANES) {
        const oldest = this.byPaneKey.keys().next().value
        if (oldest !== undefined) {
          this.byPaneKey.delete(oldest)
        }
      }
    }
    return id
  }

  /** A published row with its own conversation's id, so the id changes exactly when the row's
   *  provider key does. Chat rows carry their own ids. */
  stamp<T extends PublishedAgentRow>(row: T): T {
    const orcaSessionId = row.structuredHost
      ? null
      : this.identify(
          {
            agent: row.payload.agentType,
            providerSession: row.providerSession,
            connectionId: row.connectionId
          },
          row.paneKey
        )
    return orcaSessionId ? { ...row, orcaSessionId } : row
  }

  /** Whether this host minted `id` for a terminal conversation. */
  isTerminalIdentity(id: string): boolean {
    return this.withStore((store) => store.has(id)) === true
  }

  close(): void {
    this.store?.close()
    this.store = null
    this.storePath = null
    this.reopenAt = 0
    this.byPaneKey.clear()
  }

  private withStore<T>(read: (store: AgentIdentityStore) => T): T | null {
    const store = this.openStore()
    if (!store) {
      return null
    }
    try {
      const result = read(store)
      this.failing = false
      return result
    } catch (error) {
      this.reportFailure(error)
      return null
    }
  }

  private openStore(): AgentIdentityStore | null {
    const path = this.databasePath()
    if (path !== this.storePath) {
      this.close()
      this.storePath = path
    }
    if (!path || this.store || Date.now() < this.reopenAt) {
      return this.store
    }
    try {
      this.store = new AgentIdentityStore(path)
    } catch (error) {
      // An unopenable file must not cost every status publish a retry.
      this.reopenAt = Date.now() + REOPEN_DELAY_MS
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
