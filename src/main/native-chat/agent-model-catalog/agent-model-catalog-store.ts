import { AgentModelCatalogInputs } from './agent-model-catalog-inputs'
import { createAgentModelEffortDiscovery } from './agent-model-catalog-effort-discovery'
import { createAgentModelCatalogFences } from './agent-model-catalog-fences'
import {
  evictAgentModelCatalogEntries,
  createAgentModelCatalogEntryFactory,
  createAgentModelCatalogSuccessWriter,
  retireAgentModelCatalogObservations,
  agentModelCatalogLaunchAgents,
  agentModelCatalogEntryIsStale
} from './agent-model-catalog-entry-lifetime'
import { independentAgentModelCatalog } from '../../../shared/agent-session/options/agent-model-catalog-ownership'
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

export const AGENT_MODEL_CATALOG_MAX_ENTRIES = 256

import {
  refreshAgentModelCatalogListing,
  retireAgentModelCatalogListing,
  type AgentModelCatalogListModels,
  type AgentModelCatalogListingBudget,
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
  private readonly inputs: AgentModelCatalogInputs
  private readonly dueEntries = new Set<string>()
  private readonly partialAttempts = new Map<string, { agent: string; at: number }>()
  private readonly retirementRevisions = new Map<string, number>()
  // Aborts when an agent's scopes are next retired.
  readonly retirements = createAgentModelCatalogFences<string>()
  private readonly retiredObservations = new Set<string>()
  private persistence: AgentModelCatalogPersistence | null = null
  readonly efforts: ReturnType<typeof createAgentModelEffortDiscovery>
  private readonly now: () => number

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now
    this.failures = new AgentModelCatalogFailures(this.now)
    this.inputs = new AgentModelCatalogInputs({
      entries: this.entries,
      refreshes: this.refreshes,
      dueEntries: this.dueEntries,
      failures: this.failures,
      partialAttempts: this.partialAttempts,
      listingWaiters: this.listingWaiters,
      agents: () => agentModelCatalogLaunchAgents(this.retirementRevisions, this.entries),
      retireAgent: (agent) => this.expireFailures(agent),
      cap: AGENT_MODEL_CATALOG_MAX_ENTRIES
    })
    this.efforts = createAgentModelEffortDiscovery({
      entries: this.entries,
      refreshes: this.refreshes,
      attempts: this.partialAttempts,
      failed: (key) => this.hasActiveFailure(key),
      now: this.now,
      cap: AGENT_MODEL_CATALOG_MAX_ENTRIES
    })
  }

  /** In-process listings take precedence over hydrated entries. */
  async attachPersistence(persistence: AgentModelCatalogPersistence): Promise<void> {
    this.persistence = persistence
    for (const entry of await persistence.load()) {
      if (!this.entries.has(entry.fingerprint)) {
        this.entries.set(entry.fingerprint, entry)
        this.dueEntries.add(entry.fingerprint)
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
    return agentModelCatalogEntryIsStale(entry, this.dueEntries.has(entry.fingerprint))
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
    this.retirements.retire(agent)
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

  observeInputs(fingerprint: string, stamp: string): void {
    this.inputs.observeInputs(fingerprint, stamp)
  }

  refreshInputs(userInitiated: boolean): void {
    this.inputs.refreshInputs(userInitiated)
  }

  expireScopes(agent?: string): void {
    this.inputs.expireScopes(agent)
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
    choice: AgentModelCatalogConfiguredChoice | null,
    source?: AgentModelCatalogEntry['live']
  ): void {
    const previous = this.entries.get(fingerprint)
    const entry = previous && entryWithConfiguredDefault(previous, choice, this.now(), source)
    if (!previous || !entry) {
      return
    }
    this.entries.set(fingerprint, entry)
    if (agentModelCatalogListingKey(previous) !== agentModelCatalogListingKey(entry)) {
      this.persistence?.save(() => [...this.entries.values()])
    }
    this.listingWaiters.notify(fingerprint)
  }

  private readonly writeSuccess = createAgentModelCatalogSuccessWriter(() => ({
    entries: this.entries,
    retiredObservations: this.retiredObservations,
    dueEntries: this.dueEntries,
    failures: this.failures,
    efforts: this.efforts,
    entryFromSuccess: this.entryFromSuccess,
    persistence: this.persistence,
    evict: () => this.evictOverCap()
  }))

  refresh(
    fingerprint: string,
    agent: string,
    listModels: AgentModelCatalogListModels,
    budget?: AgentModelCatalogListingBudget,
    selectedModel?: string
  ): Promise<AgentModelCatalogEntry | null> {
    this.isListing(fingerprint)
    return refreshAgentModelCatalogListing({
      fingerprint,
      agent,
      listModels,
      selectedModel,
      maxTargets: AGENT_MODEL_CATALOG_MAX_ENTRIES,
      targetDue: (model) => this.efforts.due(fingerprint, model),
      targetAttempted: (model) => this.efforts.attempted(fingerprint, agent, model),
      budget,
      refreshes: this.refreshes,
      failures: this.failures,
      listingWaiters: this.listingWaiters,
      failed: () => {
        if (this.entries.has(fingerprint)) {
          this.dueEntries.add(fingerprint)
        }
        this.partialAttempts.delete(fingerprint)
      },
      writeSuccess: (...args) => this.writeSuccess(...args)
    })
  }

  flushProgress = (key: string): void => this.refreshes.get(key)?.flush()

  isListing(fingerprint: string): boolean {
    const flight = this.refreshes.get(fingerprint)
    if (flight && !flight.current()) {
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
      (!independentAgentModelCatalog(entry.agent) || entry.discovered?.complete === true) &&
      !this.hasActiveFailure(entry.fingerprint) &&
      !this.failure(entry.fingerprint)?.unavailable
    )
  }

  pendingListing(
    ...wait: Parameters<AgentModelCatalogListingWaiters['wait']>
  ): ReturnType<AgentModelCatalogListingWaiters['wait']> {
    // Waiting on a queued listing keeps it queued.
    this.refreshes.get(wait[0])?.hold(wait[3])
    return this.listingWaiters.wait(...wait)
  }

  shouldRefresh(fingerprint: string): boolean {
    if (this.isListing(fingerprint) || this.hasActiveFailure(fingerprint)) {
      return false
    }
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
