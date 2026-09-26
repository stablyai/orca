import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsagePersistedFile,
  ClaudeUsageSession
} from '../claude-usage/types'
import type {
  CodexUsageDailyAggregate,
  CodexUsagePersistedFile,
  CodexUsageSession
} from '../codex-usage/types'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from '../opencode-usage/types'
import type {
  MuseUsageDailyAggregate,
  MuseUsagePersistedFile,
  MuseUsageSession
} from '../muse-usage/types'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import type { ClaudeUsageScanTarget } from '../claude-usage/scanner'
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
 * @param previous - Last scan's per-file cache.
 * @returns The same projection `scanClaudeUsageFiles` returns, computed off the main thread.
 */
export async function scanClaudeUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  previous: ClaudeUsagePersistedFile[] = [],
  target?: ClaudeUsageScanTarget
): Promise<{
  processedFiles: ClaudeUsagePersistedFile[]
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}> {
  const value = await scanClaudeUsageOnWorker(
    (body) => getSharedClient().scan(body),
    worktrees,
    previous,
    target
  )
  return {
    processedFiles: value.source,
    sessions: value.sessions,
    dailyAggregates: value.dailyAggregates
  }
}

/**
 * Scan Codex rollouts through the shared worker client.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param previous - Last scan's per-file cache.
 * @returns The same projection `scanCodexUsageFiles` returns, computed off the main thread.
 */
export async function scanCodexUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  previous: CodexUsagePersistedFile[] = []
): Promise<{
  processedFiles: CodexUsagePersistedFile[]
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
}> {
  const value = await scanCodexUsageOnWorker(
    (body) => getSharedClient().scan(body),
    worktrees,
    previous
  )
  return {
    processedFiles: value.source,
    sessions: value.sessions,
    dailyAggregates: value.dailyAggregates
  }
}

/**
 * Scan OpenCode usage databases through the shared worker client.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param previous - Last scan's per-database cache.
 * @returns The same projection `scanOpenCodeUsageDatabases` returns, computed off the main thread.
 */
export async function scanOpenCodeUsageDatabasesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  previous: OpenCodeUsagePersistedDatabase[] = []
): Promise<{
  processedDatabases: OpenCodeUsagePersistedDatabase[]
  sessions: OpenCodeUsageSession[]
  dailyAggregates: OpenCodeUsageDailyAggregate[]
}> {
  const value = await scanOpenCodeUsageOnWorker(
    (body) => getSharedClient().scan(body),
    worktrees,
    previous
  )
  return {
    processedDatabases: value.source,
    sessions: value.sessions,
    dailyAggregates: value.dailyAggregates
  }
}

/**
 * Scan Muse Code session logs through the shared worker client.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param previous - Last scan's per-file cache.
 * @returns The same projection `scanMuseUsageFiles` returns, computed off the main thread.
 */
export async function scanMuseUsageFilesViaWorker(
  worktrees: UsageScanWorktreeRef[],
  previous: MuseUsagePersistedFile[] = []
): Promise<{
  processedFiles: MuseUsagePersistedFile[]
  sessions: MuseUsageSession[]
  dailyAggregates: MuseUsageDailyAggregate[]
}> {
  const value = await scanMuseUsageOnWorker(
    (body) => getSharedClient().scan(body),
    worktrees,
    previous
  )
  return {
    processedFiles: value.source,
    sessions: value.sessions,
    dailyAggregates: value.dailyAggregates
  }
}
