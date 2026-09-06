import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import { DISABLED_AI_VAULT_SEARCH_COVERAGE as DISABLED_COVERAGE } from '../../shared/ai-vault-search-coverage'
import {
  aiVaultSearchHistoryCutoffMs,
  narrowsAiVaultSearchHistory,
  widensAiVaultSearchHistory,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { ensureSessionParseCacheLoaded } from '../ai-vault/session-parse-cache-persistence'
import { sessionCandidatesFromDiscoveries } from '../ai-vault/session-scanner-candidates'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from '../ai-vault/session-scanner-parse-cache'
import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from '../ai-vault/session-scanner-types'
import {
  registerSessionSearchIndexSink,
  withSessionSearchIndexRequired
} from '../ai-vault/session-search-capture'
import { pauseBackfill } from './session-search-backfill-pacing'
import { removeSessionSearchDatabase } from './session-search-schema'
import { SessionSearchStore } from './session-search-store'

// Why: the backfill shares the scanner process's cache lane with list scans,
// so it yields between files and never holds the lane for long.
const BACKFILL_YIELD_EVERY_FILES = 8
// Why: a search must see a session that is being written right now even when
// no list scan has run; re-reading the newest few files per provider is a
// readdir + stat plus the appended bytes, well under the query budget.
const REFRESH_RECENT_PER_AGENT = 12
export type SessionSearchServiceOptions = { databasePath: string } & AiVaultSearchSettings

/** Scan roots the backfill enumerates; the parent resolves them so they match list scans. */
export type SessionSearchScanRoots = Omit<AiVaultScanOptions, 'signal' | 'limit' | 'unlimited'>

/**
 * Runs inside the ai-vault scanner process. Owns the index, feeds it from every
 * parse the list scan performs, and fills in the long tail in the background.
 *
 * Disabled is the real off switch, not a UI filter: with consent withheld the
 * database is never opened, the capture sink is never registered (so ordinary
 * list scans stop writing rows), and no backfill runs.
 */
export class SessionSearchService {
  private readonly databasePath: string
  private policy: AiVaultSearchSettings
  private store: SessionSearchStore | null = null
  private backfillRun: Promise<void> | null = null
  private searchesInFlight = 0
  private releaseBackfill: (() => void) | null = null
  private backfillController: AbortController | null = null
  private stopping = false

  constructor(options: SessionSearchServiceOptions) {
    this.databasePath = options.databasePath
    this.policy = { enabled: options.enabled, historyDays: options.historyDays }
    if (this.policy.enabled) {
      this.open()
    }
  }

  /** Starts the backfill if needed, folds any appends list scans noticed, then queries. */
  async search(
    args: AiVaultSearchArgs,
    roots: SessionSearchScanRoots,
    signal?: AbortSignal
  ): Promise<AiVaultSearchResult> {
    const store = this.store
    if (!store) {
      return { hits: [], route: 'and', durationMs: 0, coverage: DISABLED_COVERAGE }
    }
    const backfill = this.ensureBackfill(roots)
    // Why: the backfill parses in this same process and an 80 MB transcript
    // blocks it for ~170 ms; a search waiting behind a run of those read as a
    // 1.5 s query. Holding the backfill for the search's duration keeps the
    // query at its own cost.
    this.searchesInFlight += 1
    try {
      if (args.refresh !== false) {
        await this.refreshRecent(roots, signal)
        await this.reindexStale(signal)
      }
      void backfill
      return store.search(args)
    } finally {
      this.searchesInFlight -= 1
      this.releaseBackfill?.()
    }
  }

  /** Resolves once no search is in flight (or the backfill is aborted); checked between files. */
  private async waitForIdleSearches(signal: AbortSignal): Promise<void> {
    while (this.searchesInFlight > 0) {
      throwIfAiVaultScanCancelled(signal)
      await new Promise<void>((resolve) => {
        const release = (): void => {
          signal.removeEventListener('abort', release)
          if (this.releaseBackfill === release) {
            this.releaseBackfill = null
          }
          resolve()
        }
        this.releaseBackfill = release
        signal.addEventListener('abort', release, { once: true })
      })
    }
  }

  /** Observational only: reading coverage must never be what starts an index build. */
  coverage(): AiVaultSearchCoverage {
    // Why: the panel reads coverage when it opens, well before the first
    // keystroke; that is the moment to pull the join's pages off disk.
    void this.store?.warm()
    return this.store?.coverage() ?? DISABLED_COVERAGE
  }

  /**
   * Applies a consent/retention change in place. Enabling opens the database and
   * starts the backfill; disabling aborts it, drops the sink, and closes the file.
   */
  async configure(
    next: AiVaultSearchSettings,
    roots: SessionSearchScanRoots,
    options: { clearIndex?: boolean } = {}
  ): Promise<AiVaultSearchCoverage> {
    const wasEnabled = this.policy.enabled
    const previousDays = this.policy.historyDays
    this.policy = { enabled: next.enabled, historyDays: next.historyDays }
    if (options.clearIndex || (wasEnabled && !next.enabled)) {
      await this.stop()
    } else if (wasEnabled && widensAiVaultSearchHistory(previousDays, next.historyDays)) {
      // Why: a finished backfill is memoized; a wider window has files it
      // skipped, so it has to enumerate again (rows already indexed are reused).
      await this.stop({ keepStore: true })
    }
    if (options.clearIndex) {
      removeSessionSearchDatabase(this.databasePath)
    }
    if (!next.enabled) {
      return DISABLED_COVERAGE
    }
    const store = this.store ?? this.open()
    const cutoff = aiVaultSearchHistoryCutoffMs(next.historyDays)
    if (
      wasEnabled &&
      cutoff !== null &&
      narrowsAiVaultSearchHistory(previousDays, next.historyDays)
    ) {
      await store.purgeOlderThan(cutoff)
    }
    this.ensureBackfill(roots)
    return this.coverage()
  }

  /** Idempotent: a running backfill is reused, a finished one is not restarted. */
  ensureBackfill(roots: SessionSearchScanRoots): Promise<void> {
    // Why: a search that lands while stop() awaits the aborted run must not
    // start a replacement that outlives the store it is about to close.
    if (!this.store || this.stopping) {
      return Promise.resolve()
    }
    if (!this.backfillRun) {
      const controller = new AbortController()
      this.backfillController = controller
      const run = this.runBackfill(roots, controller.signal)
        .catch((error) => {
          console.warn('[ai-vault-search] backfill stopped:', error)
          // Why: a failed pass must not be memoized as done; the next search
          // gets to try again instead of reporting an incomplete index forever.
          if (this.backfillRun === run) {
            this.backfillRun = null
          }
        })
        .finally(() => {
          if (this.backfillController === controller) {
            this.backfillController = null
          }
        })
      this.backfillRun = run
    }
    return this.backfillRun
  }

  invalidate(paths: readonly string[]): void {
    for (const path of paths) {
      this.store?.removeFile(path)
    }
  }

  dispose(): void {
    this.backfillController?.abort()
    this.closeStore()
  }

  private open(): SessionSearchStore {
    mkdirSync(dirname(this.databasePath), { recursive: true })
    this.store = new SessionSearchStore(this.databasePath)
    registerSessionSearchIndexSink(this.store)
    return this.store
  }

  /** Waits for the aborted backfill so its last parse cannot write to a closed store. */
  private async stop(options: { keepStore?: boolean } = {}): Promise<void> {
    this.stopping = true
    try {
      this.backfillController?.abort()
      const run = this.backfillRun
      this.backfillRun = null
      if (run) {
        await run.catch(() => undefined)
      }
      if (!options.keepStore) {
        this.closeStore()
      }
    } finally {
      this.stopping = false
    }
  }

  private closeStore(): void {
    const store = this.store
    this.store = null
    if (!store) {
      return
    }
    registerSessionSearchIndexSink(null)
    store.close()
  }

  private async refreshRecent(roots: SessionSearchScanRoots, signal?: AbortSignal): Promise<void> {
    const issues: AiVaultScanIssue[] = []
    const options: AiVaultScanOptions = { ...roots, signal }
    const discoveries = await discoverAiVaultSessionSources({
      options,
      limitPerAgent: REFRESH_RECENT_PER_AGENT,
      issues
    })
    const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)
    await this.parseAll(this.withinHistory(candidates), signal)
  }

  private async reindexStale(signal?: AbortSignal): Promise<void> {
    const store = this.store
    const stale = store?.takeStale() ?? []
    if (stale.length === 0 || !store) {
      return
    }
    try {
      await this.parseAll(stale, signal)
    } catch (error) {
      // Why: a cancelled search (the renderer retires them per keystroke) must
      // not lose the queue; whatever did not get parsed goes back for next time.
      for (const candidate of stale) {
        store.markStale(candidate)
      }
      throw error
    }
  }

  /** The retention bound is enforced on enumeration; already-indexed rows survive until a clear. */
  private withinHistory(candidates: SessionFileCandidate[]): SessionFileCandidate[] {
    const cutoff = aiVaultSearchHistoryCutoffMs(this.policy.historyDays)
    return cutoff === null
      ? candidates
      : candidates.filter((candidate) => candidate.file.mtimeMs >= cutoff)
  }

  private async runBackfill(roots: SessionSearchScanRoots, signal: AbortSignal): Promise<void> {
    const store = this.store
    if (!store) {
      return
    }
    store.setBackfillState('running')
    try {
      await ensureSessionParseCacheLoaded()
      const issues: AiVaultScanIssue[] = []
      const options: AiVaultScanOptions = { ...roots, signal }
      const discoveries = await discoverAiVaultSessionSources({
        options,
        limitPerAgent: Number.POSITIVE_INFINITY,
        issues
      })
      const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)
      this.recordDiscovered(discoveries, issues)
      await this.parseAll(this.withinHistory(candidates), signal, { yieldToSearches: signal })
      store.setBackfillState('complete')
    } catch (error) {
      this.store?.setBackfillState('idle')
      throw error
    }
  }

  /** Discovered-vs-indexed is the only way a provider that indexes nothing stays visible. */
  private recordDiscovered(
    discoveries: readonly SessionFileDiscovery[],
    issues: readonly AiVaultScanIssue[]
  ): void {
    const files = new Map<AiVaultAgent, number>()
    for (const discovery of discoveries) {
      files.set(discovery.agent, (files.get(discovery.agent) ?? 0) + discovery.files.length)
    }
    const failures = new Map<AiVaultAgent, number>()
    for (const issue of issues) {
      if (issue.kind !== 'notice') {
        failures.set(issue.agent, (failures.get(issue.agent) ?? 0) + 1)
      }
    }
    for (const agent of new Set([...files.keys(), ...failures.keys()])) {
      this.store?.setDiscovered(agent, files.get(agent) ?? 0, failures.get(agent) ?? 0)
    }
  }

  private async parseAll(
    candidates: SessionFileCandidate[],
    signal?: AbortSignal,
    options: { yieldToSearches?: AbortSignal } = {}
  ): Promise<void> {
    const stats = createSessionParseStats()
    let sinceYield = 0
    await withSessionSearchIndexRequired(async () => {
      for (const candidate of candidates) {
        throwIfAiVaultScanCancelled(signal)
        // A concurrent disable closed the store; stop rather than parse into nothing.
        if (!this.store) {
          return
        }
        try {
          await parseAgentSessionFileCached(candidate, process.platform, stats)
        } catch (error) {
          this.store?.recordParseFailure(candidate.agent)
          console.warn('[ai-vault-search] backfill skipped', candidate.file.path, error)
        }
        if (options.yieldToSearches && this.searchesInFlight > 0) {
          await this.waitForIdleSearches(options.yieldToSearches)
        }
        sinceYield += 1
        if (sinceYield >= BACKFILL_YIELD_EVERY_FILES) {
          sinceYield = 0
          await pauseBackfill(signal)
        }
      }
    })
  }
}
