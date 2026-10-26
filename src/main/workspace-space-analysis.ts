import type { Store } from './persistence'
import { spawnProcessOnWorkerThread } from './worker-thread-child-process/worker-thread-child-process'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceScanProgress
} from '../shared/workspace-space-types'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import {
  WorkspaceSpaceScanCancelledError,
  createWorkspaceSpaceScanLimiter,
  throwIfWorkspaceSpaceScanAborted
} from './workspace-space-scan-control'
import {
  scanWorkspaceSpaceRepo,
  summarizeWorkspaceSpaceRows,
  type WorkspaceSpaceAnalyzeOptions,
  type WorkspaceSpaceScanLimiters
} from './workspace-space-repo-scan'

const REPO_SCAN_CONCURRENCY = 2
const LOCAL_WORKTREE_SCAN_CONCURRENCY = 1
const DU_TIMEOUT_MS = 120_000
const DU_MAX_BUFFER_BYTES = 16 * 1024 * 1024

export { WorkspaceSpaceScanCancelledError }

async function readLocalDuDepthOne(rootPath: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof spawnProcessOnWorkerThread> | undefined
    let onAbort: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const chunks: Buffer[] = []
    let outputBytes = 0
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort)
      }
      callback()
    }
    timer = setTimeout(() => {
      settle(() => {
        child?.kill()
        reject(new Error(`du timed out after ${DU_TIMEOUT_MS}ms`))
      })
    }, DU_TIMEOUT_MS)
    onAbort = () => {
      settle(() => {
        child?.kill()
        reject(new WorkspaceSpaceScanCancelledError())
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      child = spawnProcessOnWorkerThread({ program: 'du', args: ['-k', '-d', '1', rootPath] })
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) {
          return
        }
        outputBytes += chunk.length
        if (outputBytes > DU_MAX_BUFFER_BYTES) {
          settle(() => {
            child?.kill()
            reject(new Error('du output exceeded the scan buffer limit'))
          })
          return
        }
        chunks.push(chunk)
      })
      child.on('error', (error: Error) => settle(() => reject(error)))
      child.on('close', (code: number | null) => {
        settle(() =>
          code === 0
            ? resolve(Buffer.concat(chunks).toString('utf8'))
            : reject(new Error(`du exited with code ${code}`))
        )
      })
    } catch (error) {
      settle(() => reject(error))
    }
  })
}

export async function analyzeWorkspaceSpace(
  store: Store,
  options: WorkspaceSpaceAnalyzeOptions = {}
): Promise<WorkspaceSpaceAnalysis> {
  throwIfWorkspaceSpaceScanAborted(options.signal)
  const scannedAt = Date.now()
  const reposToScan = store.getRepos()
  const progress: WorkspaceSpaceScanProgress = {
    scanId: options.scanId ?? String(scannedAt),
    state: 'running',
    startedAt: scannedAt,
    updatedAt: scannedAt,
    totalRepoCount: reposToScan.length,
    scannedRepoCount: 0,
    totalWorktreeCount: 0,
    scannedWorktreeCount: 0,
    currentRepoDisplayName: null,
    currentWorktreeDisplayName: null
  }
  options.onProgress?.({ ...progress })
  const limiters: WorkspaceSpaceScanLimiters = {
    localWorktree: createWorkspaceSpaceScanLimiter(LOCAL_WORKTREE_SCAN_CONCURRENCY, options.signal)
  }
  const repoResults = await mapWithConcurrency(reposToScan, REPO_SCAN_CONCURRENCY, (repo) =>
    scanWorkspaceSpaceRepo({
      repo,
      scannedAt,
      store,
      limiters,
      progress,
      options,
      readLocalDuDepthOne
    })
  )
  throwIfWorkspaceSpaceScanAborted(options.signal)
  const repos = repoResults.map((result) => result.summary)
  const worktrees = repoResults
    .flatMap((result) => result.worktrees)
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.displayName.localeCompare(b.displayName))
  throwIfWorkspaceSpaceScanAborted(options.signal)
  const summary = summarizeWorkspaceSpaceRows(worktrees)
  let unavailableRepoCount = 0
  for (const repo of repos) {
    if (repo.error !== null) {
      unavailableRepoCount += 1
    }
  }
  return {
    scannedAt,
    totalSizeBytes: summary.totalSizeBytes,
    reclaimableBytes: summary.reclaimableBytes,
    worktreeCount: worktrees.length,
    scannedWorktreeCount: summary.scannedWorktreeCount,
    unavailableWorktreeCount: summary.unavailableWorktreeCount + unavailableRepoCount,
    repos,
    worktrees
  }
}
