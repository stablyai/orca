import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
export type { AgentModelCatalogProbe } from './agent-model-catalog-discovery'
import type { AgentModelCatalogPersistence } from './agent-model-catalog-persistence'
import {
  agentModelCatalogEntryWithSuccess,
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

// Claude/Codex inventory has one discovery owner per launch scope; other agents
// retain separate discovery and live listings. Stale entries remain displayable,
// while proof requires fresh discovery completed in this process.
// Success-only: a failure, timeout or empty list is never stored as a catalog
// and never persisted — it is held separately under a short TTL so a burst of
// picker opens does not hammer a dead binary, then dies on its own (see
// `AgentModelCatalogFailures`, which also holds why no chat can start under the account).

export const AGENT_MODEL_CATALOG_FRESH_MS = 10 * 60_000
export const AGENT_MODEL_CATALOG_MAX_ENTRIES = 256

import {
  refreshAgentModelCatalogListing,
  type AgentModelCatalogLister,
  type InFlightListings
} from './agent-model-catalog-lister'
export type { AgentModelCatalogSessionAccess } from './agent-model-catalog-lister'

export class AgentModelCatalogStore {
  private readonly entries = new Map<string, AgentModelCatalogEntry>()
  private readonly failures: AgentModelCatalogFailures
  private readonly refreshes = new Map<string, InFlightListings>()
  private readonly listingWaiters = new AgentModelCatalogListingWaiters(
    (fingerprint) => this.get(fingerprint),
    (fingerprint) => this.refreshes.has(fingerprint)
  )
  private readonly latestWrittenOrder = new Map<string, number>()
  // Catalogs listed under a command or env the agent no longer launches with; cleared by a discovery.
  private readonly dueEntries = new Set<string>()
  private readonly partialAttempts = new Map<string, { agent: string; at: number }>()
  private nextListingOrder = 0
  private persistence: AgentModelCatalogPersistence | null = null
  private readonly now: () => number

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now
    this.failures = new AgentModelCatalogFailures(this.now)
  }

  /** Hydrates last-good entries from disk. Anything this run already listed wins. */
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
    // Refresh recency for the LRU cap.
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    return entry
  }

  /** Whether any account's catalog of `agent` is saved here. */
  hasEntryForAgent(agent: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.agent === agent) {
        return true
      }
    }
    return false
  }

  /** Only a discovery ages: live saves never postpone the next account-level listing. */
  isStale(entry: AgentModelCatalogEntry): boolean {
    return (
      this.dueEntries.has(entry.fingerprint) ||
      !entry.discovered ||
      (independentAgentModelCatalog(entry.agent) && entry.discovered.complete !== true) ||
      this.now() - entry.discovered.at >=
        (independentAgentModelCatalog(entry.agent) ? 2 * 60_000 : AGENT_MODEL_CATALOG_FRESH_MS)
    )
  }

  failureDetail(fingerprint: string): string | null {
    return this.hasActiveFailure(fingerprint)
      ? (this.failures.get(fingerprint)?.detail ?? null)
      : null
  }

  hasActiveFailure(fingerprint: string): boolean {
    return this.failures.isActive(fingerprint)
  }

  failure(fingerprint: string): AgentModelCatalogFailure | null {
    return this.failures.get(fingerprint)
  }

  expireFailures(agent: string): void {
    this.failures.expireAgent(agent)
  }

  expireFailure(fingerprint: string): void {
    this.failures.expire(fingerprint)
  }

  /** The agent's command or launch env changed: each of its catalogs and held reasons is due. */
  expireAgent(agent: string): void {
    for (const entry of this.entries.values()) {
      if (entry.agent === agent) {
        this.dueEntries.add(entry.fingerprint)
      }
    }
    this.failures.expireAgent(agent)
    for (const [key, attempt] of this.partialAttempts) {
      if (attempt.agent === agent) {
        this.partialAttempts.delete(key)
      }
    }
  }

  /** The one ingestion step every listing goes through, whoever listed it. */
  recordSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ): AgentModelCatalogEntry | null {
    const entry = this.writeSuccess(fingerprint, agent, success, source, ++this.nextListingOrder)
    this.listingWaiters.notify(fingerprint)
    return entry
  }

  private entryFromSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource
  ): AgentModelCatalogEntry | null {
    return agentModelCatalogEntryWithSuccess(
      this.entries.get(fingerprint),
      { agent, fingerprint },
      success,
      source,
      this.now()
    )
  }

  /** Records which model and effort the account's own config resolves to, for an agent whose
   *  listing names none; null forgets a default that config no longer resolves to. Superseded by
   *  the next chat that resolves it; never creates an entry on its own. */
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
    this.persistence?.save([...this.entries.values()])
    this.listingWaiters.notify(fingerprint)
  }

  private writeSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    source: AgentModelCatalogSource,
    order: number
  ): AgentModelCatalogEntry | null {
    const entry = this.entryFromSuccess(fingerprint, agent, success, source)
    if (!entry) {
      if (source === 'discovery' && independentAgentModelCatalog(agent)) {
        this.failures.probeFailed(fingerprint, agent, new Error('agent listed no models'))
      }
      return null
    }
    const previous = this.entries.get(fingerprint)
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    if (source === 'discovery' && this.refreshes.has(fingerprint)) {
      this.latestWrittenOrder.set(fingerprint, order)
    }
    // A live listing is not the account's answer: it neither clears a failure nor a probe's verdict.
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
    // Live sessions re-list every turn; an unchanged listing only refreshes the in-memory age.
    if (!previous || agentModelCatalogListingKey(previous) !== agentModelCatalogListingKey(entry)) {
      this.persistence?.save([...this.entries.values()])
    }
    return entry
  }

  recordFailure(fingerprint: string, detail: string, agent?: string): void {
    this.failures.chatFailed(fingerprint, detail, agent)
  }

  /** Independent discovery joins by scope; other agents join only their own lister.
   *  Resolves with the entry on success, null on failure. */
  refresh(
    fingerprint: string,
    agent: string,
    lister: AgentModelCatalogLister,
    listModels: () => Promise<AgentModelCatalogSuccess>
  ): Promise<AgentModelCatalogEntry | null> {
    return refreshAgentModelCatalogListing({
      fingerprint,
      agent,
      lister,
      listModels,
      refreshes: this.refreshes,
      entries: this.entries,
      latestWrittenOrder: this.latestWrittenOrder,
      failures: this.failures,
      listingWaiters: this.listingWaiters,
      nextListingOrder: () => ++this.nextListingOrder,
      entryFromSuccess: (...args) => this.entryFromSuccess(...args),
      writeSuccess: (...args) => this.writeSuccess(...args),
      recordFailure: (...args) => this.recordFailure(...args)
    })
  }

  isListing(fingerprint: string): boolean {
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

  /** A picker follows the current account work until a catalog lands, all work ends,
   *  or its fixed deadline expires. */
  pendingListing(
    fingerprint: string,
    waitForChange = false,
    terminal = false
  ): Promise<AgentModelCatalogEntry | null> | null {
    return this.listingWaiters.wait(fingerprint, waitForChange, terminal)
  }

  /** True when a read should kick a background refresh: nothing known or the
   *  entry aged out, and no failure is still inside its TTL. */
  shouldRefresh(fingerprint: string): boolean {
    if (this.refreshes.has(fingerprint) || this.hasActiveFailure(fingerprint)) {
      return false
    }
    for (const [key, attempt] of this.partialAttempts) {
      if (this.now() - attempt.at >= 2 * 60_000) {
        this.partialAttempts.delete(key)
      }
    }
    if (this.partialAttempts.has(fingerprint)) {
      return false
    }
    const entry = this.entries.get(fingerprint)
    return !entry || this.isStale(entry)
  }

  /** A probe's reason past its TTL. Only a probe re-derives it, however fresh the catalog beside
   *  it, so only probe paths ask; a chat's own listing would never clear it. */
  heldReasonDue(fingerprint: string): boolean {
    return (
      this.failures.get(fingerprint)?.unavailable !== undefined &&
      !this.hasActiveFailure(fingerprint)
    )
  }

  /** Whether a session-less probe should list now: the refresh rule, or a held reason due. */
  probeDue(fingerprint: string): boolean {
    return (
      this.shouldRefresh(fingerprint) ||
      (!this.refreshes.has(fingerprint) && this.heldReasonDue(fingerprint))
    )
  }

  private evictOverCap(): void {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= AGENT_MODEL_CATALOG_MAX_ENTRIES) {
        return
      }
      this.entries.delete(key)
      this.dueEntries.delete(key)
      this.partialAttempts.delete(key)
    }
  }
}

/** The host process's one store. Persistence is attached where the app knows
 *  its state directory; unit tests build their own store instead. */
export const agentModelCatalogStore = new AgentModelCatalogStore()
