import { agentModelCatalogEntry, type AgentModelCatalogEntry } from './agent-model-catalog-entry'
import type { AgentModelCatalogFailures } from './agent-model-catalog-failures'
import type { AgentModelCatalogListingWaiters } from './agent-model-catalog-listing-waiters'
import { retireAgentModelCatalogListing, type InFlightListing } from './agent-model-catalog-lister'

export class AgentModelCatalogInputs {
  private readonly inputStamps = new Map<string, string>()

  constructor(
    private readonly state: {
      entries: Map<string, AgentModelCatalogEntry>
      refreshes: Map<string, InFlightListing>
      dueEntries: Set<string>
      failures: AgentModelCatalogFailures
      partialAttempts: Map<string, { agent: string; at: number }>
      listingWaiters: AgentModelCatalogListingWaiters
      agents: () => Iterable<string>
      retireAgent: (agent: string) => void
      cap: number
    }
  ) {}

  observeInputs(fingerprint: string, stamp: string): void {
    const previous = this.inputStamps.get(fingerprint)
    this.inputStamps.delete(fingerprint)
    this.inputStamps.set(fingerprint, stamp)
    if (previous !== stamp && (previous !== undefined || this.state.entries.has(fingerprint))) {
      this.expireScope(fingerprint)
    }
    if (this.inputStamps.size > this.state.cap) {
      this.inputStamps.delete(this.inputStamps.keys().next().value!)
    }
  }

  expireScope(fingerprint: string): void {
    const flight = this.state.refreshes.get(fingerprint)
    if (flight) {
      retireAgentModelCatalogListing(
        this.state.refreshes,
        this.state.listingWaiters,
        fingerprint,
        flight
      )
    }
    if (this.state.entries.has(fingerprint)) {
      this.state.dueEntries.add(fingerprint)
    }
    this.state.failures.expire(fingerprint)
    this.state.partialAttempts.delete(fingerprint)
    const prefix = `${JSON.stringify([fingerprint]).slice(0, -1)},`
    for (const key of this.state.partialAttempts.keys()) {
      if (key.startsWith(prefix)) {
        this.state.partialAttempts.delete(key)
      }
    }
  }

  relistScope(fingerprint: string): void {
    if (!this.state.refreshes.get(fingerprint)?.current()) {
      this.expireScope(fingerprint)
    }
  }

  /** With `before`, the listings running at the switch: one started after it is the new account's. */
  forgetSeenRows(fingerprints: readonly string[], before?: ReadonlySet<InFlightListing>): void {
    for (const fingerprint of fingerprints) {
      const entry = this.state.entries.get(fingerprint)
      if (entry) {
        const { agent, discovered, live, configured } = entry
        const unseen = agentModelCatalogEntry(agent, fingerprint, discovered, live, configured)
        if (unseen) {
          this.state.entries.set(fingerprint, unseen)
        }
      }
      // Also a first listing still running under the previous login: what it finds is dropped.
      const flight = this.state.refreshes.get(fingerprint)
      if (!before || !flight || before.has(flight)) {
        this.expireScope(fingerprint)
      }
    }
  }

  refreshInputs(userInitiated: boolean): void {
    for (const agent of this.state.agents()) {
      this.state.failures.expireAgent(agent)
    }
    if (userInitiated) {
      this.expireScopes()
    }
  }

  expireScopes(agent?: string): void {
    if (agent) {
      this.state.retireAgent(agent)
    }
    const scopes = new Set([
      ...[...this.state.entries.values()]
        .filter((entry) => !agent || entry.agent === agent)
        .map((entry) => entry.fingerprint),
      ...[...this.state.refreshes]
        .filter(([, flight]) => !agent || flight.agent === agent)
        .map(([fingerprint]) => fingerprint)
    ])
    for (const fingerprint of scopes) {
      this.expireScope(fingerprint)
    }
  }
}
