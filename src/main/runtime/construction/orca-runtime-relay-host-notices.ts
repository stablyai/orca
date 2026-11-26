// The runtime layer that tells phones what a desktop relays changed, so they re-read instead of polling.
import { OrcaRuntimeWithAgentQuestions } from './orca-runtime-agent-questions'

export abstract class OrcaRuntimeWithRelayHostNotices extends OrcaRuntimeWithAgentQuestions {
  /** What mobileRelay.hosts.list answers changed. */
  notifyRelayHostsChanged(): void {
    this.emitClientEvent({ type: 'relayHostsChanged' })
  }

  /** A relayed server's agent rows changed. */
  notifyRelayHostRowsChanged(hostId: `runtime:${string}`): void {
    this.emitClientEvent({ type: 'relayHostRowsChanged', hostId })
  }
}
