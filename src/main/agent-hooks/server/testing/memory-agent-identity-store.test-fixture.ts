import { randomUUID } from 'node:crypto'
import { isOrcaSessionId, type OrcaSessionId } from '../../../../shared/orca-session-address'
import type { AgentProviderKey } from '../../identity/agent-provider-key'
import type {
  AgentIdentityClient,
  AgentIdentityLookup
} from '../../identity/agent-identity-worker-client'
import { AgentHookServerAgentIdentities } from '../server-agent-identities'

/** An identity store held in memory: one stable id per key and store path, answered
 *  asynchronously, with no worker thread or file. */
export class MemoryAgentIdentityClient implements AgentIdentityClient {
  private readonly ids = new Map<string, OrcaSessionId>()

  async identify(path: string, key: AgentProviderKey): Promise<AgentIdentityLookup> {
    const keyString = JSON.stringify([path, key])
    const id = this.ids.get(keyString) ?? `${key.agent}_${randomUUID()}`
    if (!isOrcaSessionId(id)) {
      return undefined
    }
    this.ids.set(keyString, id)
    return { id }
  }

  async has(path: string, orcaSessionId: string): Promise<boolean> {
    const pathPrefix = JSON.stringify([path]).slice(0, -1)
    return [...this.ids].some(([key, id]) => id === orcaSessionId && key.startsWith(pathPrefix))
  }

  readonly isRetiring = false

  retired(): Promise<void> {
    return Promise.resolve()
  }

  dispose(): void {}
}

// Hook-server suites run from source, where the identity worker has no built entry; the worker's
// own suites cover it. Every hook-server owner these suites start gets an in-memory store.
Reflect.set(
  AgentHookServerAgentIdentities.prototype,
  'createAgentIdentityClient',
  () => new MemoryAgentIdentityClient()
)
