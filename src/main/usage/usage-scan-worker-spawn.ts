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

// Keep built-entry layout and the shared singleton outside provider stores and the transport client.

export const USAGE_SCAN_WORKER_ENTRY_FILENAME = 'usage-scan-worker-entry.js'

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    USAGE_SCAN_WORKER_ENTRY_FILENAME
  )
  // Reject missing entries synchronously; never await a worker that cannot become ready.
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

export function scanCodexUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
}> {
  return scanCodexUsageOnWorker((body) => getSharedClient().scan(body), worktrees, sourceCache)
}

export function scanOpenCodeUsageDatabasesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: OpenCodeUsageSession[]
  dailyAggregates: OpenCodeUsageDailyAggregate[]
}> {
  return scanOpenCodeUsageOnWorker((body) => getSharedClient().scan(body), worktrees, sourceCache)
}

export function scanMuseUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<{
  sessions: MuseUsageSession[]
  dailyAggregates: MuseUsageDailyAggregate[]
}> {
  return scanMuseUsageOnWorker((body) => getSharedClient().scan(body), worktrees, sourceCache)
}

/** Split source records on the worker; return only report JSON and whether migration occurred. */
export function splitUsageCacheFileViaWorker(
  request: UsageCacheSplitRequest
): Promise<UsageCacheSplitResult> {
  return getSharedClient().splitCacheFile(request)
}
