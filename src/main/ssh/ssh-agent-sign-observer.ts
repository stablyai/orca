import {
  BaseAgent,
  createAgent,
  type IdentityCallback,
  type ParsedKey,
  type SignCallback,
  type SigningRequestOptions
} from 'ssh2'

type AgentPublicKey = Parameters<BaseAgent['sign']>[0]

/**
 * Delegates to the real agent and records when the host asked it to sign. ssh2 only signs after the
 * host accepted the agent key (PK_OK), so a sign is the only evidence that an agent key partially
 * succeeded: ssh2 swallows that failure's partialSuccess flag and method list for agent keys.
 */
class SignObservingAgent extends BaseAgent<ParsedKey | Buffer | string> {
  private resolved: BaseAgent | null = null

  constructor(
    private readonly source: BaseAgent | string,
    private readonly onSign: () => void
  ) {
    super()
  }

  // Resolved on first use so building an auth queue never opens an agent the attempt won't reach.
  private get agent(): BaseAgent {
    this.resolved ??= typeof this.source === 'string' ? createAgent(this.source) : this.source
    return this.resolved
  }

  getIdentities(callback: IdentityCallback): void {
    this.agent.getIdentities(callback)
  }

  sign(
    pubKey: AgentPublicKey,
    data: Buffer,
    optionsOrCallback?: SigningRequestOptions | SignCallback,
    callback?: SignCallback
  ): void {
    this.onSign()
    if (typeof optionsOrCallback === 'function') {
      this.agent.sign(pubKey, data, optionsOrCallback)
      return
    }
    this.agent.sign(pubKey, data, optionsOrCallback ?? {}, callback)
  }
}

export function observeAgentSigning(agent: BaseAgent | string, onSign: () => void): BaseAgent {
  return new SignObservingAgent(agent, onSign)
}
