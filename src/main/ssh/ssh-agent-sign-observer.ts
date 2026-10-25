import {
  BaseAgent,
  createAgent,
  type IdentityCallback,
  type ParsedKey,
  type SignCallback,
  type SigningRequestOptions
} from 'ssh2'

type AgentPublicKey = Parameters<BaseAgent['sign']>[0]

/** ssh2 signs only after PK_OK; observe signatures because it drops agent partialSuccess/method-list evidence. */
class SignObservingAgent extends BaseAgent<ParsedKey | Buffer | string> {
  private resolved: BaseAgent | null = null

  constructor(
    private readonly source: BaseAgent | string,
    private readonly onSign: () => void
  ) {
    super()
  }

  // Resolve lazily so queue construction cannot open an agent the attempt never uses.
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
