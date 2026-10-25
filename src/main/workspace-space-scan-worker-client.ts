import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { Repo } from '../shared/repo-types'
import type { Worktree } from '../shared/worktree/types'
import type { WorkspaceSpaceWorktree } from '../shared/workspace-space-types'
import { WorkerThreadRequestQueue } from './worker-thread-request-queue'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from './worker-thread-entry-path'
import type {
  WorkspaceSpaceScanWorkerRequest,
  WorkspaceSpaceScanWorkerResponse
} from './workspace-space-scan-worker-protocol'

const WORKER_FILENAME = 'workspace-space-scan-worker-entry.js'
const WORKER_TIMEOUT_MS = 5 * 60_000
const IDLE_TEARDOWN_MS = 60_000

function createWorker(): Worker {
  const path = resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_FILENAME)
  if (!existsSync(path)) {
    throw new Error(`Workspace space scan worker entry not found: ${path}`)
  }
  return new Worker(path)
}

let queue: WorkerThreadRequestQueue<
  WorkspaceSpaceScanWorkerRequest,
  WorkspaceSpaceScanWorkerResponse
> | null = null

function getQueue(): WorkerThreadRequestQueue<
  WorkspaceSpaceScanWorkerRequest,
  WorkspaceSpaceScanWorkerResponse
> {
  queue ??= new WorkerThreadRequestQueue({
    factory: createWorker,
    idleTeardownMs: IDLE_TEARDOWN_MS,
    maxConsecutiveDeaths: 3,
    awaitRetirement: true,
    createUnavailableError: (message) =>
      new Error(`Workspace space worker unavailable: ${message}`),
    describeTimeout: (timeoutMs) => `Workspace space worker timed out after ${timeoutMs}ms`,
    describeExit: (code) => `Workspace space worker exited with code ${code}`,
    describeCrashLoop: (error) => `Workspace space worker crashed repeatedly: ${error}`,
    onUnavailable: (error) => console.warn('[workspace-space] Scan worker unavailable:', error)
  })
  return queue
}

export async function scanLocalWorkspaceSpaceWorktreeViaWorker(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  duOutput: string | null,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  const response = await getQueue().dispatch(
    (id) => ({ id, repo, worktree, scannedAt, duOutput }),
    WORKER_TIMEOUT_MS,
    signal
  )
  if (!response.ok) {
    throw new Error(response.error)
  }
  return response.row
}
