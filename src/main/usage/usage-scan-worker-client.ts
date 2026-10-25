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

// #20940: serialize provider scans with WorkerThreadRequestQueue; LazyWorkerThreadHost owns thread lifetime and the spawn module owns layout/singleton.

// Cold corpora can exceed any total deadline; time only gaps between progress reports. A huge rollout is one gap, so keep the window generous.
export const USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS = 10 * 60_000
// Keep the worker through provider-refresh bursts, then release the idle thread.
export const IDLE_TEARDOWN_MS = 60_000
export const MAX_CONSECUTIVE_DEATHS = 3

/** Thrown when no worker could be started at all, as distinct from a fault. */
export class UsageScanWorkerUnavailableError extends Error {}

type ProviderScanResult<TSession, TDaily> = {
  sessions: TSession[]
  dailyAggregates: TDaily[]
}

/** Unavailable, timed-out or crashed workers reject; stores retain their previous projection instead of parsing on main. */
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
      // Missing/resource-starved workers must fail closed; main-thread scanning would reintroduce event-loop blocking.
      onUnavailable: (err) =>
        log(`[usage-scan] worker unavailable; usage scans will report an error. ${message(err)}`)
    })
  }

  /** sourceCache identifies provider records that stay on the worker. */
  scan(body: UsageScanWorkerScanBody): Promise<UsageScanWorkerValue> {
    return this.dispatch(body)
  }

  /** Split a cache that still carries its per-source records, so main parses only the report. */
  async splitCacheFile(request: UsageCacheSplitRequest): Promise<UsageCacheSplitResult> {
    const value = await this.dispatch({ operation: 'splitCacheFile', ...request })
    if (value.operation !== 'splitCacheFile') {
      throw new Error(`Usage scan worker answered ${value.operation}, expected splitCacheFile`)
    }
    return {
      reportText: value.reportText,
      migrated: value.migrated,
      ...(value.reportIntegrityVerified === undefined
        ? {}
        : { reportIntegrityVerified: value.reportIntegrityVerified })
    }
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
