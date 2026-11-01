import { parentPort } from 'node:worker_threads'
import { scanClaudeUsageFiles } from '../claude-usage/scanner'
import { scanCodexUsageFiles } from '../codex-usage/scanner'
import { scanOpenCodeUsageDatabases } from '../opencode-usage/scanner'
import { scanMuseUsageFiles } from '../muse-usage/scanner'
import { normalizeMuseUsagePersistedFiles } from '../muse-usage/persisted-file-normalization'
import { normalizeOpenCodeUsagePersistedDatabases } from '../opencode-usage/persisted-database-normalization'
import {
  readClaudeUsageSourceCache,
  splitClaudeUsageCacheFile,
  persistClaudeUsageSourceCache
} from '../claude-usage/persisted-source-cache'
import type { CodexUsagePersistedFile } from '../codex-usage/types'
import type { OpenCodeUsagePersistedDatabase } from '../opencode-usage/types'
import type { MuseUsagePersistedFile } from '../muse-usage/types'
import type {
  UsageScanWorkerProgress,
  UsageScanWorkerRequest,
  UsageScanWorkerResponse,
  UsageScanWorkerScanBody,
  UsageScanWorkerValue
} from './usage-scan-worker-protocol'
import {
  readUsageSourceCache,
  splitUsageCacheFile,
  writeUsageSourceCache,
  type UsageSourceCacheRef
} from './usage-source-cache-file'

// #20940: serial history/SQLite scans stay off main; imports must remain Electron-free (plain-node-entry-guard).
// OpenCode WSL overrides can fork a transcript sidecar. Worker teardown only closes IPC; the sidecar exits on disconnect. Future children need explicit ownership if disconnect does not stop them. Sidecars restart per worker lifecycle.

if (!parentPort) {
  throw new Error('Usage scan worker must run with a parent port.')
}
const port = parentPort

// Rate-limit file progress to avoid waking main per file while keeping the no-progress deadline alive.
const PROGRESS_POST_INTERVAL_MS = 1_000

function createProgressReporter(id: number): (count: number) => void {
  let filesScanned = 0
  let lastPostedAt = 0
  return (count) => {
    filesScanned += count
    const now = Date.now()
    if (now - lastPostedAt < PROGRESS_POST_INTERVAL_MS) {
      return
    }
    lastPostedAt = now
    const progress: UsageScanWorkerProgress = { id, filesScanned }
    port.postMessage(progress)
  }
}

async function runRequest(
  request: UsageScanWorkerRequest,
  onFilesScanned: (count: number) => void
): Promise<UsageScanWorkerValue> {
  if (request.operation === 'splitCacheFile') {
    return {
      operation: 'splitCacheFile',
      ...(await (request.providerId === 'claude'
        ? splitClaudeUsageCacheFile(request)
        : splitUsageCacheFile(request)))
    }
  }
  return runScan(request, onFilesScanned)
}

async function runScan(
  request: UsageScanWorkerScanBody,
  onFilesScanned: (count: number) => void
): Promise<UsageScanWorkerValue> {
  // The switch narrows each provider's cache type without assertions.
  switch (request.providerId) {
    case 'claude': {
      const previous = await readClaudeUsageSourceCache(request.sourceCache)
      const result = await scanClaudeUsageFiles(
        request.worktrees,
        previous.sources,
        onFilesScanned,
        request.profileDirs,
        previous.verifiedSources
      )
      try {
        await persistClaudeUsageSourceCache(request.sourceCache, result.processedFiles, previous)
      } catch (error) {
        console.warn('[usage-scan] Could not persist the per-source usage cache:', error)
      }
      return {
        operation: 'scan',
        providerId: 'claude',
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates
      }
    }
    case 'codex': {
      const result = await scanCodexUsageFiles(
        request.worktrees,
        await readUsageSourceCache<CodexUsagePersistedFile>(request.sourceCache),
        onFilesScanned
      )
      await persistSourceCache(request.sourceCache, result.processedFiles)
      return {
        operation: 'scan',
        providerId: 'codex',
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates
      }
    }
    case 'opencode': {
      const result = await scanOpenCodeUsageDatabases(
        request.worktrees,
        normalizeOpenCodeUsagePersistedDatabases(
          await readUsageSourceCache<OpenCodeUsagePersistedDatabase>(request.sourceCache)
        ),
        onFilesScanned
      )
      await persistSourceCache(request.sourceCache, result.processedDatabases)
      return {
        operation: 'scan',
        providerId: 'opencode',
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates
      }
    }
    case 'muse': {
      const result = await scanMuseUsageFiles(
        request.worktrees,
        normalizeMuseUsagePersistedFiles(
          await readUsageSourceCache<MuseUsagePersistedFile>(request.sourceCache)
        ),
        onFilesScanned
      )
      await persistSourceCache(request.sourceCache, result.processedFiles)
      return {
        operation: 'scan',
        providerId: 'muse',
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates
      }
    }
  }
}

// Cache persistence failure must not fail a successful scan; next time it starts colder.
async function persistSourceCache(
  sourceCache: UsageSourceCacheRef,
  sources: readonly unknown[]
): Promise<void> {
  try {
    await writeUsageSourceCache(sourceCache, sources)
  } catch (error) {
    console.warn('[usage-scan] Could not persist the per-source usage cache:', error)
  }
}

async function handleRequest(request: UsageScanWorkerRequest): Promise<UsageScanWorkerResponse> {
  try {
    return {
      id: request.id,
      ok: true,
      value: await runRequest(request, createProgressReporter(request.id))
    }
  } catch (err) {
    return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

port.on('message', (request: UsageScanWorkerRequest) => {
  void handleRequest(request).then((response) => {
    try {
      port.postMessage(response)
    } catch {
      // Reject non-cloneable results immediately instead of leaving the caller to time out.
      port.postMessage({
        id: request.id,
        ok: false,
        error: 'Usage scan worker result could not be serialized.'
      })
    }
  })
})
