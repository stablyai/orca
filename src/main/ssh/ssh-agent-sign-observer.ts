import type {
  BaseAgent,
  IdentityCallback,
  ParsedKey,
  SignCallback,
  SigningRequestOptions
} from 'ssh2'
import { loadSsh2 } from './ssh2-module-load'

type AgentPublicKey = Parameters<BaseAgent['sign']>[0]

// Define on first use: extending BaseAgent would otherwise load ssh2 at startup (#35731).
function defineSignObservingAgent() {
  /** ssh2 signs only after PK_OK; observe signatures because it drops agent partialSuccess/method-list evidence. */
  return class SignObservingAgent extends loadSsh2().BaseAgent<ParsedKey | Buffer | string> {
    private resolved: BaseAgent | null = null

    constructor(
      private readonly source: BaseAgent | string,
      private readonly onSign: () => void
    ) {
      super()
    }

    // Resolve lazily so queue construction cannot open an agent the attempt never uses.
    private get agent(): BaseAgent {
      this.resolved ??=
        typeof this.source === 'string' ? loadSsh2().createAgent(this.source) : this.source
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
}

let SignObservingAgent: ReturnType<typeof defineSignObservingAgent> | null = null

export function observeAgentSigning(agent: BaseAgent | string, onSign: () => void): BaseAgent {
  SignObservingAgent ??= defineSignObservingAgent()
  return new SignObservingAgent(agent, onSign)
}
