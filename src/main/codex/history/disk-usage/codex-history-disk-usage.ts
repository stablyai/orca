import type { Worker } from 'node:worker_threads'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import { WorkerThreadRequestQueue } from '../../../worker-threads/worker-thread-request-queue'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { listHostCodexRolloutHomes } from '../cleanup/codex-host-rollout-homes'
import type {
  CodexHistoryDiskUsageWorkerRequest,
  CodexHistoryDiskUsageWorkerResponse
} from './codex-history-disk-usage-worker-protocol'
import { createCodexHistoryDiskUsageReader } from './codex-history-disk-usage-reader'

const WORKER_FILENAME = 'codex-history-disk-usage-worker-entry.js'
// A walk past these reports a lower bound rather than holding a disk busy.
// Counts every hard-linked name: a 400k-rollout history linked into four homes is 1.6M.
const MAX_ENTRIES = 4_000_000
const WALK_BUDGET_MS = 60_000
const WORKER_TIMEOUT_MS = WALK_BUDGET_MS + 30_000
const IDLE_TEARDOWN_MS = 30_000
// Each walk stats every rollout name; reopening the page within this window reuses the last one.
const REUSE_MS = 5 * 60_000

function createWorker(): Worker {
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME),
    { name: 'orca-codex-history-disk-usage' }
  )
}

let queue: WorkerThreadRequestQueue<
  CodexHistoryDiskUsageWorkerRequest,
  CodexHistoryDiskUsageWorkerResponse
> | null = null

function getQueue(): NonNullable<typeof queue> {
  queue ??= new WorkerThreadRequestQueue({
    factory: createWorker,
    idleTeardownMs: IDLE_TEARDOWN_MS,
    maxConsecutiveDeaths: 3,
    awaitRetirement: true,
    createUnavailableError: (message) =>
      new Error(`Codex history disk usage worker unavailable: ${message}`),
    describeTimeout: (timeoutMs) => `Codex history disk usage timed out after ${timeoutMs}ms`,
    describeExit: (code) => `Codex history disk usage worker exited with code ${code}`,
    describeCrashLoop: (error) => `Codex history disk usage worker crashed repeatedly: ${error}`,
    onUnavailable: (error) => console.warn('[codex-history] Disk usage worker unavailable:', error)
  })
  return queue
}

async function measure(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): Promise<CodexHistoryDiskUsage> {
  const homes = await listHostCodexRolloutHomes(settings)
  const response = await getQueue().dispatch(
    (id) => ({
      id,
      homes,
      budget: { maxEntries: MAX_ENTRIES, deadline: Date.now() + WALK_BUDGET_MS }
    }),
    WORKER_TIMEOUT_MS
  )
  if (!response.ok) {
    throw new Error(response.error)
  }
  return response.usage
}

const reader = createCodexHistoryDiskUsageReader(REUSE_MS)

/** Orca deleted rollouts: the next read walks again. */
export function forgetCodexHistoryDiskUsage(): void {
  reader.forget()
}

/** Read-only and off the main thread; callers asking during a walk share it. */
export function getCodexHistoryDiskUsage(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): Promise<CodexHistoryDiskUsage> {
  return reader.read(() => measure(settings))
}
