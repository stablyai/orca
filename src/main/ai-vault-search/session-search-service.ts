import { mkdirSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname } from 'node:path'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import {
  aiVaultSearchHistoryCutoffMs,
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
import { removeSessionSearchDatabase } from './session-search-schema'
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

/** null (all history) is the widest bound; otherwise more days means wider. */
function widensHistory(previous: number | null, next: number | null): boolean {
  if (previous === null) {
    return false
  }
  return next === null || next > previous
}

// Why: Windows reports a zero load average, so the only signal left is the
// scanner's own recent CPU share; back off when it has been near a full core.
const WINDOWS_SELF_CPU_SHARE_CEILING = 0.8
let lastCpuSample: { usage: NodeJS.CpuUsage; at: number } | null = null

function selfCpuShareSinceLastYield(): number {
  const now = performance.now()
  const usage = process.cpuUsage()
  const previous = lastCpuSample
  lastCpuSample = { usage, at: now }
  if (!previous) {
    return 0
  }
  const busyMs = (usage.user - previous.usage.user + usage.system - previous.usage.system) / 1000
  const elapsedMs = Math.max(1, now - previous.at)
  return busyMs / elapsedMs
}

function backfillPauseMs(): number {
  if (process.platform === 'win32') {
    return selfCpuShareSinceLastYield() > WINDOWS_SELF_CPU_SHARE_CEILING
      ? BACKFILL_LOAD_PAUSE_MS
      : BACKFILL_YIELD_MS
  }
  const perCpu = loadavg()[0] / Math.max(1, cpus().length)
  return perCpu > BACKFILL_LOAD_PER_CPU_CEILING ? BACKFILL_LOAD_PAUSE_MS : BACKFILL_YIELD_MS
}

export type SessionSearchServiceOptions = { databasePath: string } & AiVaultSearchSettings

/** Scan roots the backfill enumerates; the parent resolves them so they match list scans. */
export type SessionSearchScanRoots = Omit<AiVaultScanOptions, 'signal' | 'limit' | 'unlimited'>

const DISABLED_COVERAGE: AiVaultSearchCoverage = {
  enabled: false,
  sessionsIndexed: 0,
  messagesIndexed: 0,
  providers: [],
  backfill: 'idle',
  filesPending: 0,
  lastIndexedAt: null
}

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
  private backfillController: AbortController | null = null

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
    if (args.refresh !== false) {
      await this.refreshRecent(roots, signal)
      await this.reindexStale(signal)
    }
    void backfill
    return store.search(args)
  }

  /** Observational only: reading coverage must never be what starts an index build. */
  coverage(): AiVaultSearchCoverage {
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
    } else if (wasEnabled && widensHistory(previousDays, next.historyDays)) {
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
    if (!this.store) {
      this.open()
    }
    this.ensureBackfill(roots)
    return this.coverage()
  }

  /** Idempotent: a running backfill is reused, a finished one is not restarted. */
  ensureBackfill(roots: SessionSearchScanRoots): Promise<void> {
    if (!this.store) {
      return Promise.resolve()
    }
    if (!this.backfillRun) {
      this.backfillController = new AbortController()
      const run = this.runBackfill(roots, this.backfillController.signal)
        .catch((error) => {
          console.warn('[ai-vault-search] backfill stopped:', error)
          // Why: a failed pass must not be memoized as done; the next search
          // gets to try again instead of reporting an incomplete index forever.
          if (this.backfillRun === run) {
            this.backfillRun = null
          }
        })
        .finally(() => {
          this.backfillController = null
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

  private open(): void {
    mkdirSync(dirname(this.databasePath), { recursive: true })
    this.store = new SessionSearchStore(this.databasePath)
    registerSessionSearchIndexSink(this.store)
  }

  /** Waits for the aborted backfill so its last parse cannot write to a closed store. */
  private async stop(options: { keepStore?: boolean } = {}): Promise<void> {
    this.backfillController?.abort()
    const run = this.backfillRun
    this.backfillRun = null
    if (run) {
      await run.catch(() => undefined)
    }
    if (!options.keepStore) {
      this.closeStore()
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
      await this.parseAll(this.withinHistory(candidates), signal)
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

  private async parseAll(candidates: SessionFileCandidate[], signal?: AbortSignal): Promise<void> {
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
        sinceYield += 1
        if (sinceYield >= BACKFILL_YIELD_EVERY_FILES) {
          sinceYield = 0
          await new Promise((resolve) => setTimeout(resolve, backfillPauseMs()))
        }
      }
    })
  }
}
