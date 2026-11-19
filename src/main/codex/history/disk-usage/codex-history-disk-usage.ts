import type { Worker } from 'node:worker_threads'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import { WorkerThreadRequestQueue } from '../../../worker-threads/worker-thread-request-queue'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import { listHostCodexRolloutHomeSources } from '../cleanup/codex-host-rollout-homes'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import type {
  CodexHistoryDiskUsageWorkerRequest,
  CodexHistoryDiskUsageWorkerResponse
} from './codex-history-disk-usage-worker-protocol'
import { createCodexHistoryDiskUsageReader } from './codex-history-disk-usage-reader'
import { withTimeoutResult } from '../../../../shared/concurrency/promise-timeout-fallback'

const WORKER_FILENAME = 'codex-history-disk-usage-worker-entry.js'
// A walk past these reports a lower bound rather than holding a disk busy.
// Counts every hard-linked name: a 400k-rollout history linked into four homes is 1.6M.
const MAX_ENTRIES = 4_000_000
const WALK_BUDGET_MS = 60_000
const WORKER_TIMEOUT_MS = WALK_BUDGET_MS + 30_000
const IDLE_TEARDOWN_MS = 30_000
// A stopped worker stuck in a blocking call on a hung mount never exits; give up rather than wait.
const RETIREMENT_WAIT_MS = 10_000
const PREPARATION_WAIT_MS = 10_000
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

type CappedResult<T> = { ok: true; value: T } | { ok: false }

/** Callers share one run of the task; once it outlasts the cap they fail fast, attaching nothing, until it ends. */
function sharedCappedTask<T>(capMs: number): (start: () => Promise<T>) => Promise<CappedResult<T>> {
  let capped: Promise<CappedResult<T>> | null = null
  return (start) => {
    if (!capped) {
      const running = start()
      capped = withTimeoutResult(running, capMs)
      const ended = (): void => {
        capped = null
      }
      running.then(ended, ended)
    }
    return capped
  }
}

function untilAbandoned<T>(
  wait: Promise<CappedResult<T>>,
  signal: AbortSignal
): Promise<CappedResult<T>> {
  if (signal.aborted) {
    return Promise.resolve({ ok: false })
  }
  const abandoned = new Promise<CappedResult<T>>((resolve) =>
    signal.addEventListener('abort', () => resolve({ ok: false }), { once: true })
  )
  return Promise.race([wait, abandoned])
}

// Neither can be cancelled, and a hung mount can stall both; shared runs keep abandoned reads from piling up.
const listHomeSources =
  sharedCappedTask<Awaited<ReturnType<typeof listHostCodexRolloutHomeSources>>>(PREPARATION_WAIT_MS)
const previousWorkerExited = sharedCappedTask<void>(RETIREMENT_WAIT_MS)

async function measure(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>,
  signal: AbortSignal
): Promise<CodexHistoryDiskUsage> {
  const listed = await untilAbandoned(
    listHomeSources(() => listHostCodexRolloutHomeSources(settings)),
    signal
  )
  if (!listed.ok) {
    throw new Error('Codex homes could not be listed')
  }
  const { homes, accounts } = listed.value
  // A walk stopped by a release or deletion ends its worker; wait for it so this one can start.
  const exited = await untilAbandoned(
    previousWorkerExited(() => getQueue().retired()),
    signal
  )
  if (!exited.ok) {
    throw new Error('the previous Codex history walk has not stopped')
  }
  const response = await getQueue().dispatch(
    (id) => ({
      id,
      homes,
      accounts,
      systemCodexHomePath: getSystemCodexHomePath(),
      budget: { maxEntries: MAX_ENTRIES, timeMs: WALK_BUDGET_MS }
    }),
    WORKER_TIMEOUT_MS,
    // Aborting the running walk ends its worker, so a superseded walk stops visiting files.
    signal
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
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>,
  consumerId?: string
): Promise<CodexHistoryDiskUsage> {
  return reader.read((signal) => measure(settings, signal), consumerId)
}

/** A settings view stopped waiting; the walk stops once no view waits for it. */
export function releaseCodexHistoryDiskUsage(consumerId: string): void {
  reader.release(consumerId)
}
