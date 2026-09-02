import { mkdirSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname } from 'node:path'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { ensureSessionParseCacheLoaded } from '../ai-vault/session-parse-cache-persistence'
import { sessionCandidatesFromDiscoveries } from '../ai-vault/session-scanner-candidates'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from '../ai-vault/session-scanner-parse-cache'
import { discoverAiVaultSessionSources } from '../ai-vault/session-scanner-source-discovery'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { AiVaultScanOptions, SessionFileCandidate } from '../ai-vault/session-scanner-types'
import {
  registerSessionSearchIndexSink,
  withSessionSearchIndexRequired
} from '../ai-vault/session-search-capture'
import { SessionSearchStore } from './session-search-store'

// Why: the backfill shares the scanner process's cache lane with list scans,
// so it yields between files and never holds the lane for long.
const BACKFILL_YIELD_EVERY_FILES = 8
const BACKFILL_YIELD_MS = 5
// Why: a search must see a session that is being written right now even when
// no list scan has run; re-reading the newest few files per provider is a
// readdir + stat plus the appended bytes, well under the query budget.
const REFRESH_RECENT_PER_AGENT = 12
// Why: the backfill is the one CPU-heavy thing this feature does, and it runs
// unasked. When the host is already saturated it backs off in coarse steps
// instead of competing; the per-file cursor makes every pause free.
const BACKFILL_LOAD_PER_CPU_CEILING = 1.5
const BACKFILL_LOAD_PAUSE_MS = 15_000

function backfillPauseMs(): number {
  const perCpu = loadavg()[0] / Math.max(1, cpus().length)
  return perCpu > BACKFILL_LOAD_PER_CPU_CEILING ? BACKFILL_LOAD_PAUSE_MS : BACKFILL_YIELD_MS
}

export type SessionSearchServiceOptions = {
  databasePath: string
}

/** Scan roots the backfill enumerates; the parent resolves them so they match list scans. */
export type SessionSearchScanRoots = Omit<AiVaultScanOptions, 'signal' | 'limit' | 'unlimited'>

/**
 * Runs inside the ai-vault scanner process. Owns the index, feeds it from every
 * parse the list scan performs, and fills in the long tail in the background.
 */
export class SessionSearchService {
  private readonly store: SessionSearchStore
  private backfillRun: Promise<void> | null = null
  private backfillController: AbortController | null = null

  constructor(options: SessionSearchServiceOptions) {
    mkdirSync(dirname(options.databasePath), { recursive: true })
    this.store = new SessionSearchStore(options.databasePath)
    registerSessionSearchIndexSink(this.store)
  }

  /** Starts the backfill if needed, folds any appends list scans noticed, then queries. */
  async search(
    args: AiVaultSearchArgs,
    roots: SessionSearchScanRoots,
    signal?: AbortSignal
  ): Promise<AiVaultSearchResult> {
    const backfill = this.ensureBackfill(roots)
    if (args.refresh !== false) {
      await this.refreshRecent(roots, signal)
      await this.reindexStale(signal)
    }
    void backfill
    return this.store.search(args)
  }

  coverage(roots: SessionSearchScanRoots): AiVaultSearchCoverage {
    this.ensureBackfill(roots)
    return this.store.coverage()
  }

  /** Idempotent: a running backfill is reused, a finished one is not restarted. */
  ensureBackfill(roots: SessionSearchScanRoots): Promise<void> {
    if (!this.backfillRun) {
      this.backfillController = new AbortController()
      this.backfillRun = this.runBackfill(roots, this.backfillController.signal)
        .catch((error) => console.warn('[ai-vault-search] backfill stopped:', error))
        .finally(() => {
          this.backfillController = null
        })
    }
    return this.backfillRun
  }

  invalidate(paths: readonly string[]): void {
    for (const path of paths) {
      this.store.removeFile(path)
    }
  }

  dispose(): void {
    this.backfillController?.abort()
    registerSessionSearchIndexSink(null)
    this.store.close()
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
    await this.parseAll(candidates, signal)
  }

  private async reindexStale(signal?: AbortSignal): Promise<void> {
    const stale = this.store.takeStale()
    if (stale.length === 0) {
      return
    }
    await this.parseAll(stale, signal)
  }

  private async runBackfill(roots: SessionSearchScanRoots, signal: AbortSignal): Promise<void> {
    this.store.setBackfillState('running')
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
      await this.parseAll(candidates, signal)
      this.store.setBackfillState('complete')
    } catch (error) {
      this.store.setBackfillState('idle')
      throw error
    }
  }

  private async parseAll(candidates: SessionFileCandidate[], signal?: AbortSignal): Promise<void> {
    const stats = createSessionParseStats()
    let sinceYield = 0
    await withSessionSearchIndexRequired(async () => {
      for (const candidate of candidates) {
        throwIfAiVaultScanCancelled(signal)
        try {
          await parseAgentSessionFileCached(candidate, process.platform, stats)
        } catch (error) {
          console.warn('[ai-vault-search] backfill skipped', candidate.file.path, error)
        }
        sinceYield += 1
        if (sinceYield >= BACKFILL_YIELD_EVERY_FILES) {
          sinceYield = 0
          await new Promise((resolve) => setTimeout(resolve, backfillPauseMs()))
        }
      }
    })
  }
}
