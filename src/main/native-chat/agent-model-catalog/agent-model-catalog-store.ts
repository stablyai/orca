import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'
import type { AgentModelCatalogPersistence } from './agent-model-catalog-persistence'

// The execution host's one model catalog per (agent, launch fingerprint):
// served immediately at any age, refreshed in the background when old, and
// written through by every successful listing a live session already performs.
// Success-only: a failure, timeout or empty list is never stored as a catalog
// and never persisted — it is held separately under a short TTL so a burst of
// picker opens does not hammer a dead binary, then dies on its own.

export const AGENT_MODEL_CATALOG_FRESH_MS = 10 * 60_000
export const AGENT_MODEL_CATALOG_FAILURE_TTL_MS = 30_000
export const AGENT_MODEL_CATALOG_PICKER_WAIT_MS = 30_000
export const AGENT_MODEL_CATALOG_MAX_ENTRIES = 256

export type AgentModelCatalogEntry = {
  agent: string
  fingerprint: string
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  /** Provider-advertised Fast tier per model id; derived from the same listing. */
  fastModeTierByModel: Record<string, string>
  origin: 'live-session' | 'probe'
  fetchedAt: number
}

export type AgentModelCatalogSuccess = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  fastModeTierByModel: ReadonlyMap<string, string>
  origin: 'live-session' | 'probe'
}

export type AgentModelCatalogProbe = (accountHomePath: string) => Promise<AgentModelCatalogSuccess>

/** Who lists, by identity: a live session's per-spawn handle, or the session-less probe. */
export type AgentModelCatalogLister = AgentModelCatalogSessionAccess | AgentModelCatalogProbe

type CatalogFailure = { detail: string; failedAt: number }

type InFlightListings = Map<AgentModelCatalogLister, Promise<AgentModelCatalogEntry | null>>

/** A live session's handle into the store, pinned at spawn to the account home
 *  THAT child launched under — an account switched afterwards must never
 *  receive or poison this session's listing. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}

function tierRecord(tiers: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(tiers.entries())
}

/** A listing that names no default effort for a model keeps the one a live child reported for it,
 *  while that model still offers it: Claude's listing never names one, only a running child does. */
function withKnownDefaultEfforts(
  models: readonly AgentSessionModelOption[],
  previous: AgentModelCatalogEntry | undefined
): AgentSessionModelOption[] {
  return models.map((model) => {
    const known = previous?.models.find((entry) => entry.id === model.id)?.defaultEffort
    return model.defaultEffort === undefined &&
      known !== undefined &&
      model.efforts.some((choice) => choice.value === known)
      ? { ...model, defaultEffort: known }
      : { ...model }
  })
}

function listingKey(entry: AgentModelCatalogEntry): string {
  return JSON.stringify([
    entry.origin,
    entry.models,
    entry.fastModeSupport ?? null,
    entry.fastModeTierByModel
  ])
}

export class AgentModelCatalogStore {
  private readonly entries = new Map<string, AgentModelCatalogEntry>()
  private readonly failures = new Map<string, CatalogFailure>()
  private readonly refreshes = new Map<string, InFlightListings>()
  private readonly listingWaiters = new Map<string, Set<() => void>>()
  private readonly latestWrittenOrder = new Map<string, number>()
  private nextListingOrder = 0
  private persistence: AgentModelCatalogPersistence | null = null
  private readonly now: () => number

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now
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

  isStale(entry: AgentModelCatalogEntry): boolean {
    return this.now() - entry.fetchedAt >= AGENT_MODEL_CATALOG_FRESH_MS
  }

  failureDetail(fingerprint: string): string | null {
    return this.hasActiveFailure(fingerprint)
      ? (this.failures.get(fingerprint)?.detail ?? null)
      : null
  }

  hasActiveFailure(fingerprint: string): boolean {
    const failure = this.failures.get(fingerprint)
    if (!failure) {
      return false
    }
    if (this.now() - failure.failedAt >= AGENT_MODEL_CATALOG_FAILURE_TTL_MS) {
      this.failures.delete(fingerprint)
      return false
    }
    return true
  }

  recordSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess
  ): AgentModelCatalogEntry | null {
    const entry = this.writeSuccess(fingerprint, agent, success, ++this.nextListingOrder)
    this.notifyListingWaiters(fingerprint)
    return entry
  }

  private entryFromSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess
  ): AgentModelCatalogEntry | null {
    if (success.models.length === 0) {
      // An empty list identifies no model; it is doubt, not a catalog.
      return null
    }
    const previous = this.entries.get(fingerprint)
    return {
      agent,
      fingerprint,
      models: withKnownDefaultEfforts(success.models, previous),
      ...(success.fastModeSupport ? { fastModeSupport: success.fastModeSupport } : {}),
      fastModeTierByModel: tierRecord(success.fastModeTierByModel),
      origin: success.origin,
      fetchedAt: this.now()
    }
  }

  private writeSuccess(
    fingerprint: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    order: number
  ): AgentModelCatalogEntry | null {
    const entry = this.entryFromSuccess(fingerprint, agent, success)
    if (!entry) {
      return null
    }
    const previous = this.entries.get(fingerprint)
    this.entries.delete(fingerprint)
    this.entries.set(fingerprint, entry)
    if (this.refreshes.has(fingerprint)) {
      this.latestWrittenOrder.set(fingerprint, order)
    }
    this.failures.delete(fingerprint)
    this.evictOverCap()
    // Live sessions re-list every turn; an unchanged listing only refreshes the in-memory age.
    if (!previous || listingKey(previous) !== listingKey(entry)) {
      this.persistence?.save([...this.entries.values()])
    }
    return entry
  }

  recordFailure(fingerprint: string, detail: string): void {
    this.failures.set(fingerprint, { detail, failedAt: this.now() })
  }

  /** Joins an in-flight refresh by the same lister rather than starting a second. Never
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
      this.notifyListingWaiters(fingerprint)
    }
    const order = ++this.nextListingOrder
    const run = listModels().then(
      (success) => {
        // An older session still receives its own result, but cannot replace a newer catalog.
        const entry =
          (this.latestWrittenOrder.get(fingerprint) ?? 0) > order && this.entries.has(fingerprint)
            ? this.entryFromSuccess(fingerprint, agent, success)
            : this.writeSuccess(fingerprint, agent, success, order)
        settle()
        return entry
      },
      (error: unknown) => {
        settle()
        this.recordFailure(fingerprint, error instanceof Error ? error.message : String(error))
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
    if (!this.refreshes.has(fingerprint)) {
      return null
    }
    return new Promise((resolve) => {
      const waiters = this.listingWaiters.get(fingerprint) ?? new Set<() => void>()
      let settled = false
      const finish = (entry: AgentModelCatalogEntry | null): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(deadline)
        waiters.delete(check)
        if (waiters.size === 0) {
          this.listingWaiters.delete(fingerprint)
        }
        resolve(entry)
      }
      const check = (): void => {
        const entry = this.get(fingerprint)
        if (entry || !this.refreshes.has(fingerprint)) {
          finish(entry)
        }
      }
      const deadline = setTimeout(
        () => finish(this.get(fingerprint)),
        AGENT_MODEL_CATALOG_PICKER_WAIT_MS
      )
      waiters.add(check)
      this.listingWaiters.set(fingerprint, waiters)
      check()
    })
  }

  private notifyListingWaiters(fingerprint: string): void {
    for (const check of this.listingWaiters.get(fingerprint) ?? []) {
      check()
    }
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

  private evictOverCap(): void {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= AGENT_MODEL_CATALOG_MAX_ENTRIES) {
        return
      }
      this.entries.delete(key)
    }
  }
}

/** The host process's one store. Persistence is attached where the app knows
 *  its state directory; unit tests build their own store instead. */
export const agentModelCatalogStore = new AgentModelCatalogStore()
