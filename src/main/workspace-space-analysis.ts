import { execFile } from 'node:child_process'
import { platform } from 'node:process'
import type { Store } from './persistence'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceScanProgress
} from '../shared/workspace-space-types'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { escapeRegex } from '../shared/string-utils'
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
const REMOTE_FALLBACK_SCAN_CONCURRENCY = 2
const DU_TIMEOUT_MS = 120_000
const DU_MAX_BUFFER_BYTES = 16 * 1024 * 1024

export { WorkspaceSpaceScanCancelledError }

function normalizeLocalDuPath(pathValue: string): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const trimmed = pathValue.replace(new RegExp(`${escapeRegex(separator)}+$`), '')
  return trimmed.length > 0 ? trimmed : pathValue
}

function parseWorkspaceSpaceDuOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!normalizedLine) {
      continue
    }
    const match = /^(\d+)\s+(.+)$/.exec(normalizedLine)
    if (!match) {
      continue
    }
    sizes.set(normalizeLocalDuPath(match[2]), Number(match[1]) * 1024)
  }
  return sizes
}

async function readLocalDuDepthOne(
  rootPath: string,
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const stdout = await new Promise<string>((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    let onAbort: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
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
        reject(new Error('Workspace space scan cancelled'))
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    try {
      child = execFile(
        'du',
        ['-k', '-d', '1', rootPath],
        { encoding: 'utf8', maxBuffer: DU_MAX_BUFFER_BYTES, signal, timeout: DU_TIMEOUT_MS },
        (error, output) => {
          if (error) {
            settle(() => reject(error))
            return
          }
          settle(() => resolve(String(output)))
        }
      )
    } catch (error) {
      settle(() => reject(error))
    }
  })
  return parseWorkspaceSpaceDuOutput(stdout)
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
    localWorktree: createWorkspaceSpaceScanLimiter(LOCAL_WORKTREE_SCAN_CONCURRENCY, options.signal),
    remoteFallbackTraversal: createWorkspaceSpaceScanLimiter(
      REMOTE_FALLBACK_SCAN_CONCURRENCY,
      options.signal
    )
  }
  const repoResults = await mapWithConcurrency(reposToScan, REPO_SCAN_CONCURRENCY, (repo) =>
    scanWorkspaceSpaceRepo({
      repo,
      scannedAt,
      store,
      limiters,
      progress,
      options,
      readLocalDuDepthOne,
      normalizeLocalDuPath
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
