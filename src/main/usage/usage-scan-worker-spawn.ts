import { claudeProfileTranscriptDirs } from '../claude-usage/transcript-file-discovery'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type { ClaudeUsageDailyAggregate, ClaudeUsageSession } from '../claude-usage/types'
import type { CodexUsageDailyAggregate, CodexUsageSession } from '../codex-usage/types'
import type { OpenCodeUsageDailyAggregate, OpenCodeUsageSession } from '../opencode-usage/types'
import type { MuseUsageDailyAggregate, MuseUsageSession } from '../muse-usage/types'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import type {
  UsageCacheSplitRequest,
  UsageCacheSplitResult,
  UsageSourceCacheRef
} from './usage-source-cache-file'
import {
  scanClaudeUsageOnWorker,
  scanCodexUsageOnWorker,
  scanMuseUsageOnWorker,
  scanOpenCodeUsageOnWorker,
  UsageScanWorkerClient
} from './usage-scan-worker-client'

// Why: resolve the built worker entry and own the process-wide shared client, so
// the client class stays free of runtime-layout concerns and each usage store
// depends only on its own routing function below.

export const USAGE_SCAN_WORKER_ENTRY_FILENAME = 'usage-scan-worker-entry.js'

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    USAGE_SCAN_WORKER_ENTRY_FILENAME
  )
  // Why: a missing built entry must throw synchronously so the client can fail
  // closed before it waits on a worker that can never post a result.
  if (!existsSync(workerPath)) {
    throw new Error(`Usage scan worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: UsageScanWorkerClient | null = null

function getSharedClient(): UsageScanWorkerClient {
  sharedClient ??= new UsageScanWorkerClient({ workerFactory: defaultWorkerFactory })
  return sharedClient
}

/**
 * Scan Claude usage transcripts through the shared worker client.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker keeps that provider's per-source cache.
 * @returns The session and daily projections, computed off the main thread.
 */
export function scanClaudeUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}> {
  return scanClaudeUsageOnWorker(
    (body) =>
      getSharedClient().scan(
        body.providerId === 'claude'
          ? { ...body, profileDirs: claudeProfileTranscriptDirs() }
          : body
      ),
    worktrees,
    sourceCache
  )
}

/**
 * Scan Codex rollouts through the shared worker client.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker keeps that provider's per-source cache.
 * @returns The session and daily projections, computed off the main thread.
 */
export function scanCodexUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
}> {
  return scanCodexUsageOnWorker((body) => getSharedClient().scan(body), worktrees, sourceCache)
}

/**
 * Scan OpenCode usage databases through the shared worker client.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker keeps that provider's per-source cache.
 * @returns The session and daily projections, computed off the main thread.
 */
export function scanOpenCodeUsageDatabasesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: OpenCodeUsageSession[]
  dailyAggregates: OpenCodeUsageDailyAggregate[]
}> {
  return scanOpenCodeUsageOnWorker((body) => getSharedClient().scan(body), worktrees, sourceCache)
}

/**
 * Scan Muse Code session logs through the shared worker client.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param sourceCache - Where the worker keeps that provider's per-source cache.
 * @returns The session and daily projections, computed off the main thread.
 */
export function scanMuseUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: MuseUsageSession[]
  dailyAggregates: MuseUsageDailyAggregate[]
}> {
  return scanMuseUsageOnWorker((body) => getSharedClient().scan(body), worktrees, sourceCache)
}

/**
 * Split a usage cache that still carries its per-source records, through the shared worker client.
 * @param request - The cache file and the key its per-source records sit under.
 * @returns The report alone, as JSON text, and whether a split happened.
 */
export function splitUsageCacheFileViaWorker(
  request: UsageCacheSplitRequest
): Promise<UsageCacheSplitResult> {
  return getSharedClient().splitCacheFile(request)
}
