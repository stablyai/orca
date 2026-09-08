import { searchPresentSessionSources } from './session-search-source-presence'
import { SessionSearchRefreshLane, discoverRecentSearchFiles } from './session-search-refresh-lane'
import { recordSearchDiscovered } from './session-search-discovered-counts'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import {
  noAiVaultSearchIndexCoverage,
  noAiVaultSearchIndexResult
} from '../../shared/ai-vault-search-coverage'
import {
  aiVaultSearchHistoryCutoffMs,
  narrowsAiVaultSearchHistory,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { ensureSessionParseCacheLoaded } from '../ai-vault/session-parse-cache-persistence'
import { sessionCandidatesFromDiscoveries } from '../ai-vault/session-scanner-candidates'
import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { AiVaultScanOptions, SessionFileCandidate } from '../ai-vault/session-scanner-types'
import {
  getSessionSearchIndexSink,
  registerSessionSearchIndexSink
} from '../ai-vault/session-search-capture'
import { parseSearchCandidates } from './session-search-parse-candidates'
import { removeSessionSearchDatabase } from './session-search-schema'
import { SessionSearchStore } from './session-search-store'

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
  private readonly refreshLane = new SessionSearchRefreshLane()
  private searchesInFlight = 0
  private releaseBackfill: (() => void) | null = null
  private backfillController: AbortController | null = null
  private stopping = false

  constructor(options: SessionSearchServiceOptions) {
    this.databasePath = options.databasePath
    this.policy = { ...options }
    if (this.policy.enabled) {
      this.applyPolicyToStore(this.openStore())
    }
  }

  /** Starts the backfill if needed, folds any appends list scans noticed, then queries. */
  async search(
    args: AiVaultSearchArgs,
    roots: SessionSearchScanRoots,
    signal?: AbortSignal
  ): Promise<AiVaultSearchResult> {
    if (!this.store) {
      return noAiVaultSearchIndexResult(this.coverage())
    }
    const backfill = this.ensureBackfill(roots)
    // Why: the backfill parses in this same process and an 80 MB transcript
    // blocks it for ~170 ms; a search waiting behind a run of those read as a
    // 1.5 s query. Holding the backfill for the search's duration keeps the
    // query at its own cost.
    this.searchesInFlight += 1
    try {
      if (args.refresh !== false && !this.policy.paused && !this.stopping) {
        await this.refreshLane.run(
          roots,
          async (sharedSignal) => {
            await this.parseAll(
              this.withinHistory(await discoverRecentSearchFiles(roots, sharedSignal)),
              { signal: sharedSignal }
            )
            await this.reindexStale(sharedSignal)
          },
          signal
        )
      }
      void backfill
      // Why: presence checks await between query rounds, and a configure() in
      // that window closes the database; read the handle per round so a closed
      // store yields no hits instead of throwing on a freed statement.
      return await searchPresentSessionSources(
        args,
        // Why: configure() nulls the store for a microtask; answering the round
        // with DISABLED coverage would tell the panel consent was withdrawn.
        (query) => this.store?.search(query) ?? noAiVaultSearchIndexResult(this.coverage()),
        (paths) => this.invalidate(paths),
        signal
      )
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
    return this.store?.coverage() ?? noAiVaultSearchIndexCoverage(this.policy.enabled === true)
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
    this.policy = { ...next }
    if (options.clearIndex || (wasEnabled && !next.enabled)) {
      await this.stop()
    } else if (wasEnabled && (next.paused || previousDays !== next.historyDays)) {
      // Replace the memoized pass so both narrowing and widening use the new policy.
      await this.stop({ keepStore: true })
    }
    if (options.clearIndex) {
      removeSessionSearchDatabase(this.databasePath)
    }
    if (!next.enabled) {
      return noAiVaultSearchIndexCoverage(false)
    }
    const store = this.store ?? this.openStore()
    this.applyPolicyToStore(store)
    const cutoff = aiVaultSearchHistoryCutoffMs(next.historyDays)
    if (
      wasEnabled &&
      cutoff !== null &&
      narrowsAiVaultSearchHistory(previousDays, next.historyDays)
    ) {
      await store.purgeOlderThan(cutoff)
    }
    if (store.indexing.snapshot().phase === 'error') {
      this.backfillRun = null
    }
    this.ensureBackfill(roots)
    return this.coverage()
  }

  /** Idempotent: a running backfill is reused, a finished one is not restarted. */
  ensureBackfill(roots: SessionSearchScanRoots): Promise<void> {
    // Why: a search that lands while stop() awaits the aborted run must not
    // start a replacement that outlives the store it is about to close.
    if (!this.store || this.stopping || this.policy.paused) {
      return Promise.resolve()
    }
    if (!this.backfillRun) {
      const controller = new AbortController()
      this.backfillController = controller
      const run = this.runBackfill(roots, controller.signal)
        .catch((error) => {
          console.warn(
            '[ai-vault-search] backfill stopped:',
            error instanceof Error ? error.name : 'ScanError'
          )
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

  async close(): Promise<void> {
    await this.stop({ drainRefreshes: true })
  }

  /** Creation only; the caller applies the policy before anything can await. */
  private openStore(): SessionSearchStore {
    mkdirSync(dirname(this.databasePath), { recursive: true })
    const store = new SessionSearchStore(this.databasePath)
    this.store = store
    registerSessionSearchIndexSink(store)
    return store
  }

  /** The only writer of policy-derived store state; `stop()` additionally gates writes off. */
  private applyPolicyToStore(store: SessionSearchStore): void {
    store.setHistoryDays(this.policy.historyDays)
    store.setAcceptingWrites(!this.policy.paused)
    store.indexing.setPaused(this.policy.paused === true)
  }

  /** Waits for the aborted backfill so its last parse cannot write to a closed store. */
  private async stop(
    options: { keepStore?: boolean; drainRefreshes?: boolean } = {}
  ): Promise<void> {
    this.stopping = true
    const refreshes = options.drainRefreshes ? this.refreshLane.drain() : this.refreshLane.cancel()
    this.store?.setAcceptingWrites(false)
    try {
      this.backfillController?.abort()
      const run = this.backfillRun
      this.backfillRun = null
      if (run) {
        await run.catch(() => undefined)
      }
      await refreshes
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
    // Why: shutdown is async, so a replacement service may already own the sink;
    // clearing it unconditionally would silently stop feeding the new index.
    if (getSessionSearchIndexSink() === store) {
      registerSessionSearchIndexSink(null)
    }
    store.close()
  }

  private async reindexStale(signal?: AbortSignal): Promise<void> {
    const store = this.store
    const stale = store?.takeStale() ?? []
    if (stale.length === 0 || !store) {
      return
    }
    try {
      await this.parseAll(this.withinHistory(stale), { signal })
    } catch (error) {
      // Why: a cancelled search (the renderer retires them per keystroke) must
      // not lose the queue; whatever did not get parsed goes back for next time.
      for (const candidate of stale) {
        store.markStale(candidate)
      }
      throw error
    }
  }

  /** Avoid reading files the sink will reject under the current retention policy. */
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
    store.indexing.discover()
    try {
      const cutoff = aiVaultSearchHistoryCutoffMs(this.policy.historyDays)
      await store.purgeOlderThan(cutoff, signal)
      await ensureSessionParseCacheLoaded()
      const issues: AiVaultScanIssue[] = []
      const options: AiVaultScanOptions = { ...roots, signal }
      const discoveries = await discoverAiVaultSessionSources({
        options,
        limitPerAgent: Number.POSITIVE_INFINITY,
        issues
      })
      const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)
      recordSearchDiscovered(store, discoveries, issues)
      const eligible = this.withinHistory(candidates)
      store.indexing.discovered(eligible.length, issues.length)
      await this.parseAll(eligible, { signal, backfillSignal: signal })
      store.indexing.finish()
      store.setBackfillState('complete')
    } catch (error) {
      store.indexing.finish(!signal.aborted)
      this.store?.setBackfillState('idle')
      throw error
    }
  }

  /** `backfillSignal` marks the long tail: those files report progress and yield to searches. */
  private async parseAll(
    candidates: SessionFileCandidate[],
    options: { signal?: AbortSignal; backfillSignal?: AbortSignal }
  ): Promise<void> {
    const store = this.store
    const backfillSignal = options.backfillSignal
    if (!store) {
      return
    }
    await parseSearchCandidates(store, candidates, {
      signal: options.signal,
      ...(backfillSignal
        ? {
            onFileProcessed: async (failed: boolean) => {
              store.indexing.processed(failed)
              await this.waitForIdleSearches(backfillSignal)
            }
          }
        : {})
    })
  }
}
