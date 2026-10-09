import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentModelCatalogPersistence } from './agent-model-catalog-persistence'
import { startSpan } from '../../observability/tracer'
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
  AgentModelCatalogListingStoppedError,
  type AgentModelCatalogFailure
} from './agent-model-catalog-failures'
import {
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  AgentModelCatalogListingWaiters
} from './agent-model-catalog-listing-waiters'

export { AGENT_MODEL_CATALOG_FAILURE_TTL_MS, AGENT_MODEL_CATALOG_PICKER_WAIT_MS }
export type { AgentModelCatalogFailure }

// The execution host's one model catalog per (agent, launch fingerprint):
// served immediately at any age, refreshed in the background when old, and
// written through by every successful listing a live session already performs.
// Each entry keeps two listings: the last account-level discovery (the only
// source of the configured default and default efforts, and the only clock a
// refresh follows) and the last live session's listing (which models exist and
// their efforts). Readers see the two merged; neither write erases the other.
// Success-only: a failure, timeout or empty list is never stored as a catalog
// and never persisted — it is held separately under a short TTL so a burst of
// picker opens does not hammer a dead binary, then dies on its own (see
// `AgentModelCatalogFailures`, which also holds why no chat can start under the account).

export const AGENT_MODEL_CATALOG_FRESH_MS = 10 * 60_000
export const AGENT_MODEL_CATALOG_MAX_ENTRIES = 256

/** Lists an agent's models without a session, under the account a launch would pin. `signal`
 *  stops the listing and its child once the host that asked is going away. */
export type AgentModelCatalogProbe = (
  accountHome: AgentSessionAccountHome,
  options?: { signal?: AbortSignal }
) => Promise<AgentModelCatalogSuccess>

/** Who lists, by identity: a live session's per-spawn handle, or the session-less probe. */
export type AgentModelCatalogLister = AgentModelCatalogSessionAccess | AgentModelCatalogProbe

type InFlightListings = Map<AgentModelCatalogLister, Promise<AgentModelCatalogEntry | null>>

/** A live session's handle into the store, pinned at spawn to the account home
 *  THAT child launched under — an account switched afterwards must never
 *  receive or poison this session's listing. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}

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
      this.now() - entry.discovered.at >= AGENT_MODEL_CATALOG_FRESH_MS
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
      return null
    }
    const previous = this.entries.get(fingerprint)
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    if (source === 'discovery' && this.refreshes.has(fingerprint)) {
      this.latestWrittenOrder.set(fingerprint, order)
    }
    // A live listing is not the account's answer: it neither clears a failure nor a probe's verdict.
    if (source === 'discovery') {
      this.dueEntries.delete(fingerprint)
      this.failures.listed(fingerprint, agent, success.origin, success.unavailable)
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

  /** A discovery listing. Joins an in-flight refresh by the same lister rather than starting a second. Never
   *  joins another lister's: a probe or another chat's Codex that hangs must not decide
   *  whether this chat starts. Resolves with the entry on success, null on failure. */
  refresh(
    fingerprint: string,
    agent: string,
    lister: AgentModelCatalogLister,
    listModels: () => Promise<AgentModelCatalogSuccess>
  ): Promise<AgentModelCatalogEntry | null> {
    const listers: InFlightListings = this.refreshes.get(fingerprint) ?? new Map()
    const inFlight = listers.get(lister)
    if (inFlight) {
      return inFlight
    }
    const settle = (): void => {
      listers.delete(lister)
      if (listers.size === 0 && this.refreshes.get(fingerprint) === listers) {
        this.refreshes.delete(fingerprint)
        this.latestWrittenOrder.delete(fingerprint)
      }
      this.listingWaiters.notify(fingerprint)
    }
    const order = ++this.nextListingOrder
    // Agent, outcome and duration only: a slow listing shows in the trace log without its content.
    const span = startSpan('agentModelCatalog.discovery', {
      attributes: { agent, lister: typeof lister === 'function' ? 'probe' : 'session' }
    })
    const run = listModels().then(
      (success) => {
        span.setAttribute('models', success.models.length)
        span.end()
        // An older lister still receives its own result, but cannot replace a newer discovery.
        const superseded =
          (this.latestWrittenOrder.get(fingerprint) ?? 0) > order && this.entries.has(fingerprint)
        if (superseded && success.origin === 'probe') {
          this.failures.listed(fingerprint, agent, success.origin, success.unavailable)
        }
        const entry = superseded
          ? this.entryFromSuccess(fingerprint, agent, success, 'discovery')
          : this.writeSuccess(fingerprint, agent, success, 'discovery', order)
        settle()
        return entry
      },
      (error: unknown) => {
        span.fail(error instanceof Error ? error : String(error))
        settle()
        // Probes are functions; a live session lists through its access object.
        if (typeof lister === 'function') {
          if (!(error instanceof AgentModelCatalogListingStoppedError)) {
            this.failures.probeFailed(fingerprint, agent, error)
          }
        } else {
          this.recordFailure(
            fingerprint,
            error instanceof Error ? error.message : String(error),
            agent
          )
        }
        return null
      }
    )
    listers.set(lister, run)
    this.refreshes.set(fingerprint, listers)
    return run
  }

  /** A picker follows the current account work until a catalog lands, all work ends,
   *  or its fixed deadline expires. */
  pendingListing(fingerprint: string): Promise<AgentModelCatalogEntry | null> | null {
    return this.listingWaiters.wait(fingerprint)
  }

  /** True when a read should kick a background refresh: nothing known or the
   *  entry aged out, and no failure is still inside its TTL. */
  shouldRefresh(fingerprint: string): boolean {
    if (this.refreshes.has(fingerprint) || this.hasActiveFailure(fingerprint)) {
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
    }
  }
}

/** The host process's one store. Persistence is attached where the app knows
 *  its state directory; unit tests build their own store instead. */
export const agentModelCatalogStore = new AgentModelCatalogStore()
