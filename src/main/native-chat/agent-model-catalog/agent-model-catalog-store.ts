import {
  evictAgentModelCatalogEntries,
  createAgentModelCatalogEntryFactory,
  retireAgentModelCatalogObservations,
  agentModelCatalogLaunchAgents,
  agentModelCatalogEntryIsStale,
  pruneAgentModelCatalogPartialAttempts
} from './agent-model-catalog-entry-lifetime'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
export type { AgentModelCatalogProbe } from './agent-model-catalog-discovery'
import type { AgentModelCatalogPersistence } from './agent-model-catalog-persistence'
import {
  agentModelCatalogListingKey,
  entryWithConfiguredDefault,
  type AgentModelCatalogConfiguredChoice,
  type AgentModelCatalogEntry,
  type AgentModelCatalogSource,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-entry'

export type {
  AgentModelCatalogEntry,
  AgentModelCatalogListing,
  AgentModelCatalogLiveListing,
  AgentModelCatalogSource,
  AgentModelCatalogSuccess
} from './agent-model-catalog-entry'
export { withLiveCatalogListing } from './agent-model-catalog-entry'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogFailures,
  type AgentModelCatalogFailure
} from './agent-model-catalog-failures'
import {
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  AgentModelCatalogListingWaiters
} from './agent-model-catalog-listing-waiters'

export { AGENT_MODEL_CATALOG_FAILURE_TTL_MS, AGENT_MODEL_CATALOG_PICKER_WAIT_MS }
export type { AgentModelCatalogFailure }

// Persist successful catalogs only; failures/unavailability are held separately.
// Saved display data may be stale, while launch proof requires fresh discovery in this process.

export { AGENT_MODEL_CATALOG_FRESH_MS } from './agent-model-catalog-entry-lifetime'
export const AGENT_MODEL_CATALOG_MAX_ENTRIES = 256

import {
  refreshAgentModelCatalogListing,
  retireAgentModelCatalogListing,
  type InFlightListing
} from './agent-model-catalog-lister'
export type { AgentModelCatalogSessionAccess } from './agent-model-catalog-lister'

export class AgentModelCatalogStore {
  private readonly entries = new Map<string, AgentModelCatalogEntry>()
  private readonly failures: AgentModelCatalogFailures
  private readonly refreshes = new Map<string, InFlightListing>()
  private readonly listingWaiters = new AgentModelCatalogListingWaiters(
    (fingerprint) => this.get(fingerprint),
    (fingerprint) => this.refreshes.has(fingerprint)
  )
  // Changed launch commands/env invalidate catalogs until rediscovery.
  private readonly dueEntries = new Set<string>()
  private readonly partialAttempts = new Map<string, { agent: string; at: number }>()
  private readonly retirementRevisions = new Map<string, number>()
  private readonly retiredObservations = new Set<string>()
  private persistence: AgentModelCatalogPersistence | null = null
  private readonly now: () => number

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now
    this.failures = new AgentModelCatalogFailures(this.now)
  }

  /** In-process listings take precedence over hydrated entries. */
  async attachPersistence(persistence: AgentModelCatalogPersistence): Promise<void> {
    this.persistence = persistence
    for (const entry of await persistence.load()) {
      if (!this.entries.has(entry.fingerprint)) {
        this.entries.set(entry.fingerprint, entry)
        if (independentAgentModelCatalog(entry.agent)) {
          this.dueEntries.add(entry.fingerprint)
        }
      }
    }
    this.evictOverCap()
  }

  flushPersistence(): Promise<void> {
    return this.persistence?.flush() ?? Promise.resolve()
  }

  get(fingerprint: string): AgentModelCatalogEntry | null {
    const entry = this.entries.get(fingerprint)
    if (!entry) {
      return null
    }
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    return entry
  }

  /** A known superseded invocation cannot be certified by resolving its old base key again. */
  observation(fingerprint: string): AgentModelCatalogEntry | null {
    return this.retiredObservations.has(fingerprint) ? null : this.get(fingerprint)
  }

  /** Whether any account's catalog of `agent` is saved here. */
  hasEntryForAgent(agent: string): boolean {
    return [...this.entries.values()].some((entry) => entry.agent === agent)
  }

  /** Live saves must not delay account-level discovery. */
  isStale(entry: AgentModelCatalogEntry): boolean {
    return agentModelCatalogEntryIsStale(entry, this.dueEntries.has(entry.fingerprint), this.now())
  }

  failureDetail(fingerprint: string): string | null {
    return this.failures.detail(fingerprint)
  }

  hasActiveFailure(fingerprint: string): boolean {
    return this.failures.isActive(fingerprint)
  }

  failure(fingerprint: string): AgentModelCatalogFailure | null {
    return this.failures.get(fingerprint)
  }

  retirementRevision(agent: string): number {
    const revision = this.retirementRevisions.get(agent) ?? 0
    this.retirementRevisions.set(agent, revision)
    return revision
  }

  private retireListings(agent: string): void {
    this.retirementRevisions.set(agent, this.retirementRevision(agent) + 1)
    for (const [fingerprint, flight] of this.refreshes) {
      if (flight.agent === agent) {
        retireAgentModelCatalogListing(this.refreshes, this.listingWaiters, fingerprint, flight)
      }
    }
  }

  expireLaunchScopes(affected: (agent: string) => boolean = () => true): void {
    for (const agent of agentModelCatalogLaunchAgents(this.retirementRevisions, this.entries)) {
      if (affected(agent)) {
        this.expireAgent(agent)
      }
    }
  }

  expireFailures(agent: string): void {
    this.retireListings(agent)
    this.failures.expireAgent(agent)
  }

  expireFailure(fingerprint: string): void {
    this.failures.expire(fingerprint)
  }

  expireAgent(agent: string): void {
    this.retireListings(agent)
    retireAgentModelCatalogObservations(
      this.entries,
      this.dueEntries,
      this.retiredObservations,
      this.partialAttempts,
      agent
    )
    this.failures.expireAgent(agent)
  }

  recordSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ): AgentModelCatalogEntry | null {
    const entry = this.writeSuccess(fingerprint, agent, success, source)
    this.listingWaiters.notify(fingerprint)
    return entry
  }

  private readonly entryFromSuccess = createAgentModelCatalogEntryFactory(
    this.entries,
    this.retiredObservations,
    () => this.now()
  )

  /** Learn defaults only for existing catalogs; null clears facts the next chat no longer resolves. */
  recordConfiguredDefault(
    fingerprint: string,
    choice: AgentModelCatalogConfiguredChoice | null
  ): void {
    const previous = this.entries.get(fingerprint)
    const entry = previous && entryWithConfiguredDefault(previous, choice, this.now())
    if (!entry) {
      return
    }
    this.entries.set(fingerprint, entry)
    this.persistence?.save(() => [...this.entries.values()])
    this.listingWaiters.notify(fingerprint)
  }

  private writeSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ): AgentModelCatalogEntry | null {
    const entry = this.entryFromSuccess(fingerprint, agent, success, source)
    if (!entry) {
      if (source === 'discovery' && independentAgentModelCatalog(agent)) {
        this.failures.probeFailed(fingerprint, agent, new Error('agent listed no models'))
      }
      return null
    }
    this.retiredObservations.delete(fingerprint)
    const previous = this.entries.get(fingerprint)
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    // Live listings cannot clear discovery failures or account-unavailability verdicts.
    if (
      source === 'discovery' &&
      (!independentAgentModelCatalog(agent) || success.complete === true)
    ) {
      this.dueEntries.delete(fingerprint)
      this.failures.listed(fingerprint, agent, success.origin, success.unavailable)
    }
    if (source === 'discovery' && independentAgentModelCatalog(agent)) {
      this.partialAttempts.delete(fingerprint)
      if (success.complete !== true) {
        this.partialAttempts.set(fingerprint, { agent, at: this.now() })
        this.failures.listed(fingerprint, agent, success.origin, success.unavailable)
      }
      while (this.partialAttempts.size > AGENT_MODEL_CATALOG_MAX_ENTRIES) {
        const oldest = this.partialAttempts.keys().next().value
        if (oldest !== undefined) {
          this.partialAttempts.delete(oldest)
        }
      }
    }
    this.evictOverCap()
    // Unchanged per-turn listings need no disk write.
    if (!previous || agentModelCatalogListingKey(previous) !== agentModelCatalogListingKey(entry)) {
      this.persistence?.save(() => [...this.entries.values()])
    }
    return entry
  }

  /** One probe per canonical scope; failures resolve null. */
  refresh(
    fingerprint: string,
    agent: string,
    listModels: () => Promise<AgentModelCatalogSuccess>,
    current?: () => boolean,
    signal?: AbortSignal
  ): Promise<AgentModelCatalogEntry | null> {
    this.isListing(fingerprint)
    return refreshAgentModelCatalogListing({
      fingerprint,
      agent,
      listModels,
      current,
      signal,
      refreshes: this.refreshes,
      failures: this.failures,
      listingWaiters: this.listingWaiters,
      writeSuccess: (...args) => this.writeSuccess(...args)
    })
  }

  isListing(fingerprint: string): boolean {
    const flight = this.refreshes.get(fingerprint)
    if (flight?.current?.() === false) {
      retireAgentModelCatalogListing(this.refreshes, this.listingWaiters, fingerprint, flight)
    }
    return this.refreshes.has(fingerprint)
  }

  clearPartialAttempts(): void {
    this.partialAttempts.clear()
  }

  verified(entry: AgentModelCatalogEntry): boolean {
    return (
      !this.isStale(entry) &&
      !this.hasActiveFailure(entry.fingerprint) &&
      !this.failure(entry.fingerprint)?.unavailable
    )
  }

  pendingListing(
    fingerprint: string,
    waitForChange = false,
    terminal = false
  ): Promise<AgentModelCatalogEntry | null> | null {
    return this.listingWaiters.wait(fingerprint, waitForChange, terminal)
  }

  shouldRefresh(fingerprint: string): boolean {
    if (this.isListing(fingerprint) || this.hasActiveFailure(fingerprint)) {
      return false
    }
    pruneAgentModelCatalogPartialAttempts(this.partialAttempts, this.now())
    const entry = this.entries.get(fingerprint)
    return !this.partialAttempts.has(fingerprint) && (!entry || this.isStale(entry))
  }

  /** Only probes can refresh expired unavailability, even beside a fresh live catalog. */
  heldReasonDue(fingerprint: string): boolean {
    return this.failures.unavailableDue(fingerprint)
  }

  probeDue(fingerprint: string): boolean {
    return (
      this.shouldRefresh(fingerprint) ||
      (!this.isListing(fingerprint) && this.heldReasonDue(fingerprint))
    )
  }

  private evictOverCap(): void {
    evictAgentModelCatalogEntries(
      this.entries,
      this.dueEntries,
      this.partialAttempts,
      AGENT_MODEL_CATALOG_MAX_ENTRIES,
      this.retiredObservations
    )
  }
}

export const agentModelCatalogStore = new AgentModelCatalogStore()
