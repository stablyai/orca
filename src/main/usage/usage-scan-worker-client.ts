import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import type { ClaudeUsageDailyAggregate, ClaudeUsageSession } from '../claude-usage/types'
import type { CodexUsageDailyAggregate, CodexUsageSession } from '../codex-usage/types'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsageSession } from '../opencode-usage/types'
import type { MuseUsageDailyAggregate, MuseUsageSession } from '../muse-usage/types'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import type {
  UsageScanWorkerProviderId,
  UsageScanWorkerRequest,
  UsageScanWorkerRequestBody,
  UsageScanWorkerResponse,
  UsageScanWorkerScanBody,
  UsageScanWorkerValue
} from './usage-scan-worker-protocol'
import type {
  UsageCacheSplitRequest,
  UsageCacheSplitResult,
  UsageSourceCacheRef
} from './usage-source-cache-file'
import { isUsageScanWorkerProgress } from './usage-scan-worker-protocol'
import { createUsageScanWorkerTransport } from './usage-scan-worker-cache-cleanup'

// Why (#20940): this module owns the request half of the shared usage scan
// worker — FIFO one-at-a-time dispatch, a no-progress deadline, respawn-on-fault
// — while WorkerThreadRequestQueue owns the queue mechanics and
// LazyWorkerThreadHost owns the thread's lifetime. The default spawn and the
// process-wide singleton live in usage-scan-worker-spawn.ts.

// Why no-progress rather than wall clock: a cold scan of a real history is
// legitimately minutes — 637 s measured on a 30 GB corpus with 300 worktrees
// before #21130, ~51 s after — and a slower disk or a larger corpus goes past
// any fixed budget. A wall-clock deadline killed those scans, recorded a scan
// error, and left the cache unadvanced, so the next refresh started cold and
// died at the same point, forever. The worker posts a file counter as it goes
// (`UsageScanWorkerProgress`), so this window only has to cover the gap between
// two files; it stays generous because a single huge rollout is still one gap.
export const USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS = 10 * 60_000
// One user action refreshes several providers in a burst, and the store's own
// staleness window is 5 minutes. Long enough to serve a burst, short enough that
// an idle app is not holding a thread.
export const IDLE_TEARDOWN_MS = 60_000
export const MAX_CONSECUTIVE_DEATHS = 3

/** Thrown when no worker could be started at all, as distinct from a fault. */
export class UsageScanWorkerUnavailableError extends Error {}

type ProviderScanResult<TSession, TDaily> = {
  sessions: TSession[]
  dailyAggregates: TDaily[]
}

/**
 * Main-thread bridge that runs first-party usage scans on a worker thread.
 * Every route fails closed: a worker that cannot spawn, times out, or crashes
 * rejects, and the caller's store records a scan error and keeps the previous
 * projection rather than moving the parse back onto the main thread.
 */
export class UsageScanWorkerClient {
  private readonly queue: WorkerThreadRequestQueue<UsageScanWorkerRequest, UsageScanWorkerResponse>

  constructor(options: { workerFactory: WorkerThreadFactory; log?: (message: string) => void }) {
    const log = options.log ?? ((message: string) => console.warn(message))
    this.queue = new WorkerThreadRequestQueue({
      factory: () => createUsageScanWorkerTransport(options.workerFactory),
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
      createUnavailableError: (message) => new UsageScanWorkerUnavailableError(message),
      isProgress: isUsageScanWorkerProgress,
      describeTimeout: (timeoutMs) => `Usage scan worker reported no progress for ${timeoutMs}ms`,
      describeExit: (code) => `Usage scan worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `Usage scan worker crashed repeatedly (${lastError})`,
      // Why: never fall back to scanning on the main thread here. A missing
      // bundle or a resource-exhausted spawn must surface as a scan error, not
      // reintroduce the main-process occupancy this boundary exists to remove.
      onUnavailable: (err) =>
        log(`[usage-scan] worker unavailable; usage scans will report an error. ${message(err)}`)
    })
  }

  /**
   * Run one provider's scan on the worker.
   * @param body - Provider id, worktree refs, and where that provider's per-source cache lives.
   * @returns The worker's value for that provider.
   */
  scan(body: UsageScanWorkerScanBody): Promise<UsageScanWorkerValue> {
    return this.dispatch(body)
  }

  /** Split a cache that still carries its per-source records, so main parses only the report. */
  async splitCacheFile(request: UsageCacheSplitRequest): Promise<UsageCacheSplitResult> {
    const value = await this.dispatch({ operation: 'splitCacheFile', ...request })
    if (value.operation !== 'splitCacheFile') {
      throw new Error(`Usage scan worker answered ${value.operation}, expected splitCacheFile`)
    }
    return { reportText: value.reportText, migrated: value.migrated }
  }

  private async dispatch(body: UsageScanWorkerRequestBody): Promise<UsageScanWorkerValue> {
    const response = await this.queue.dispatch(
      (id) => ({ ...body, id }),
      USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS
    )
    if (!response.ok) {
      throw new Error(response.error)
    }
    return response.value
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A response for the wrong provider means the worker and client disagree on the protocol. */
function wrongProvider(expected: UsageScanWorkerProviderId, value: UsageScanWorkerValue): Error {
  const actual = value.operation === 'scan' ? value.providerId : value.operation
  return new Error(`Usage scan worker answered for ${actual}, expected ${expected}`)
}

/**
 * Scan Claude usage transcripts on the shared worker.
 * @param scan - Dispatch function, injected so tests need no real thread.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker reads and writes that provider's per-source cache.
 * @returns The session and daily projections.
 */
export async function scanClaudeUsageOnWorker(
  scan: (body: UsageScanWorkerScanBody) => Promise<UsageScanWorkerValue>,
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<ProviderScanResult<ClaudeUsageSession, ClaudeUsageDailyAggregate>> {
  const value = await scan({ operation: 'scan', providerId: 'claude', worktrees, sourceCache })
  if (value.operation !== 'scan' || value.providerId !== 'claude') {
    throw wrongProvider('claude', value)
  }
  return { sessions: value.sessions, dailyAggregates: value.dailyAggregates }
}

/**
 * Scan Codex rollouts on the shared worker.
 * @param scan - Dispatch function, injected so tests need no real thread.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker reads and writes that provider's per-source cache.
 * @returns The session and daily projections.
 */
export async function scanCodexUsageOnWorker(
  scan: (body: UsageScanWorkerScanBody) => Promise<UsageScanWorkerValue>,
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<ProviderScanResult<CodexUsageSession, CodexUsageDailyAggregate>> {
  const value = await scan({ operation: 'scan', providerId: 'codex', worktrees, sourceCache })
  if (value.operation !== 'scan' || value.providerId !== 'codex') {
    throw wrongProvider('codex', value)
  }
  return { sessions: value.sessions, dailyAggregates: value.dailyAggregates }
}

/**
 * Scan OpenCode usage databases on the shared worker.
 * @param scan - Dispatch function, injected so tests need no real thread.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker reads and writes that provider's per-source cache.
 * @returns The session and daily projections.
 */
export async function scanOpenCodeUsageOnWorker(
  scan: (body: UsageScanWorkerScanBody) => Promise<UsageScanWorkerValue>,
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<ProviderScanResult<OpenCodeUsageSession, OpenCodeUsageDailyAggregate>> {
  const value = await scan({ operation: 'scan', providerId: 'opencode', worktrees, sourceCache })
  if (value.operation !== 'scan' || value.providerId !== 'opencode') {
    throw wrongProvider('opencode', value)
  }
  return { sessions: value.sessions, dailyAggregates: value.dailyAggregates }
}

/**
 * Scan Muse Code session logs on the shared worker.
 * @param scan - Dispatch function, injected so tests need no real thread.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker reads and writes that provider's per-source cache.
 * @returns The session and daily projections.
 */
export async function scanMuseUsageOnWorker(
  scan: (body: UsageScanWorkerScanBody) => Promise<UsageScanWorkerValue>,
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<ProviderScanResult<MuseUsageSession, MuseUsageDailyAggregate>> {
  const value = await scan({ operation: 'scan', providerId: 'muse', worktrees, sourceCache })
  if (value.operation !== 'scan' || value.providerId !== 'muse') {
    throw wrongProvider('muse', value)
  }
  return { sessions: value.sessions, dailyAggregates: value.dailyAggregates }
}
