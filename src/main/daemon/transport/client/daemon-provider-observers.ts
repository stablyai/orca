import type {
  HostedProviderExitEvent,
  HostedProviderOutcome
} from '../../protocol/daemon-provider-process-protocol'

/** Provider control records address one owner; they never enter terminal stream fanout. */
export class DaemonProviderObservers {
  private readonly owners = new Map<
    string,
    { exit: (outcome: HostedProviderOutcome) => void; reconnected?: () => void }
  >()

  add(
    nonce: string,
    exit: (outcome: HostedProviderOutcome) => void,
    reconnected?: () => void
  ): () => void {
    const owner = { exit, reconnected }
    this.owners.set(nonce, owner)
    return () => {
      if (this.owners.get(nonce) === owner) {
        this.owners.delete(nonce)
      }
    }
  }

  observe(event: HostedProviderExitEvent): void {
    this.owners.get(event.nonce)?.exit(event.outcome)
  }

  reconnected(): void {
    for (const owner of this.owners.values()) {
      owner.reconnected?.()
    }
  }
}
