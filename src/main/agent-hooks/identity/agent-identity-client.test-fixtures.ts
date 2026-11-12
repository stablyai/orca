import type { AgentProviderKey } from './agent-provider-key'
import type { AgentIdentityClient, AgentIdentityLookup } from './agent-identity-worker-client'
import { handleAgentIdentityRequest } from './agent-identity-worker-entry'
import { isOrcaSessionId } from '../../../shared/orca-session-address'

/** The worker's real SQL handler behind an asynchronous boundary, counting requests. Each answer
 *  can be held so a test decides when (and in which order) replies arrive. */
export class InProcessAgentIdentityClient implements AgentIdentityClient {
  identifyRequests = 0
  hasRequests = 0
  /** When set, `identify` waits for `release()` before answering. */
  hold = false
  /** Answers the next N identify requests as unavailable after running their SQL. */
  failAfterCommit = 0
  private held: (() => void)[] = []

  async identify(path: string, key: AgentProviderKey): Promise<AgentIdentityLookup> {
    this.identifyRequests++
    if (this.hold) {
      await new Promise<void>((resolve) => this.held.push(resolve))
    }
    const response = handleAgentIdentityRequest({ id: 0, kind: 'identify', path, key })
    if (!response.ok || this.failAfterCommit-- > 0) {
      return undefined
    }
    const value = response.value
    return value === null
      ? { id: null }
      : typeof value === 'string' && isOrcaSessionId(value)
        ? { id: value }
        : undefined
  }

  async has(path: string, orcaSessionId: string): Promise<boolean | undefined> {
    this.hasRequests++
    const response = handleAgentIdentityRequest({ id: 0, kind: 'has', path, orcaSessionId })
    return response.ok && typeof response.value === 'boolean' ? response.value : undefined
  }

  /** Lets every held request answer, oldest first. */
  release(): void {
    for (const resolve of this.held.splice(0)) {
      resolve()
    }
  }

  dispose(): void {}
}
