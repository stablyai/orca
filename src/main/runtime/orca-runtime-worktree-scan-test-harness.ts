import { vi } from 'vitest'
import type { GitWorktreeInfo, Repo, WorktreeMeta } from '../../shared/types'
import { listWorktreesStrict } from '../git/worktree'
import {
  OrcaRuntimeService,
  RESOLVED_WORKTREE_FLEET_MAX_WAVES,
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
  WORKTREE_SCAN_CONCURRENCY,
  type RuntimeWorktreeScanOutcome
} from './orca-runtime'

/**
 * Shared scaffolding for the worktree-scan suites. Every builder here drives the *mocked*
 * `../git/worktree`, so each importing suite still owns the `vi.mock` calls for it.
 */

export const REPO_TIMEOUT_MS = RESOLVED_WORKTREE_REPO_TIMEOUT_MS
/** How many git processes one wave spawns — every slot-count expectation derives from this. */
export const SCAN_CONCURRENCY = WORKTREE_SCAN_CONCURRENCY
export const FLEET_MAX_WAVES = RESOLVED_WORKTREE_FLEET_MAX_WAVES
/** The ceiling a sweep spends before it stops spawning: max waves x the per-repo budget. */
export const FLEET_TIMEOUT_MS = FLEET_MAX_WAVES * REPO_TIMEOUT_MS

export type ResolvedScanWorktree = {
  id: string
  path: string
  git: GitWorktreeInfo
}

export type ScanRuntimeInternals = {
  listResolvedWorktrees: () => Promise<ResolvedScanWorktree[]>
  listRepoWorktreesForResolution: (repo: Repo) => Promise<RuntimeWorktreeScanOutcome>
  listRepoWorktreesForDetection: (
    repo: Repo,
    maxCacheAgeMs: number
  ) => Promise<RuntimeWorktreeScanOutcome>
  invalidateRepoWorktreeScan: (repoId: string) => void
  resolveWorktreeScanFleet: (repos: readonly Repo[]) => {
    localRepoCount: number
    activeLocalRepoIds: ReadonlySet<string>
    activeRepoIds: ReadonlySet<string>
  }
  invalidateWorktreeScanCacheForRepo: (repoId: string) => void
  worktreeScanBackoff: Map<string, { kind: string; failures: number }>
  worktreeScanCache: Map<string, unknown>
  worktreeScanGenerations: Map<string, number>
  worktreeScanInFlight: Map<string, unknown>
  activeLocalWorktreeScanCount: number
  ptysById: Map<string, { worktreeId: string; connected: boolean }>
  tabs: Map<string, { worktreeId: string }>
}

/** Every scan hangs until its signal aborts, so waves are paced purely by the scan deadlines. */
export function mockHungStrictScans(): {
  readonly liveProcesses: number
  readonly peakProcesses: number
} {
  const counts = { liveProcesses: 0, peakProcesses: 0 }
  vi.mocked(listWorktreesStrict).mockImplementation(
    async (_path: string, options?: { signal?: AbortSignal }) =>
      await new Promise<GitWorktreeInfo[]>((_resolve, reject) => {
        counts.liveProcesses += 1
        counts.peakProcesses = Math.max(counts.peakProcesses, counts.liveProcesses)
        options?.signal?.addEventListener(
          'abort',
          () => {
            counts.liveProcesses -= 1
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          },
          { once: true }
        )
      })
  )
  return counts
}

/** Models a real git child: it takes `latencyMs`, and dies when its signal aborts. */
export function mockStrictScansWithLatency(latencyMs: number): void {
  mockStrictScansWedgedBy(undefined, latencyMs)
}

/** Wedges every repo path matching `wedgedPaths`; the rest behave like a git child at `latencyMs`. */
export function mockStrictScansWedgedBy(wedgedPaths: RegExp | undefined, latencyMs: number): void {
  vi.mocked(listWorktreesStrict).mockImplementation(
    async (path: string, options?: { signal?: AbortSignal }) =>
      await new Promise<GitWorktreeInfo[]>((resolve, reject) => {
        const timer = wedgedPaths?.test(path)
          ? undefined
          : setTimeout(() => resolve([makeGitWorktree(path)]), latencyMs)
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          },
          { once: true }
        )
      })
  )
}

/**
 * Scans the caller resolves by hand, on a child that dies with its signal like a real git process —
 * so a test that expects a scan to finish cannot pass by ignoring a cancellation production sends.
 */
export function signalHonouringStrictScans(): ((worktrees: GitWorktreeInfo[]) => void)[] {
  const resolvers: ((worktrees: GitWorktreeInfo[]) => void)[] = []
  vi.mocked(listWorktreesStrict).mockImplementation(
    async (_path: string, options?: { signal?: AbortSignal }) =>
      await new Promise<GitWorktreeInfo[]>((resolve, reject) => {
        resolvers.push(resolve)
        options?.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true }
        )
      })
  )
  return resolvers
}

export function makeRepo(id: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'blue',
    addedAt: 1,
    ...overrides
  } as Repo
}

export function makeGitWorktree(path: string, branch = 'main'): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch,
    isBare: false,
    isMainWorktree: branch === 'main'
  }
}

export function makeScanRuntime(
  repos: Repo[],
  options: {
    metaById?: Record<string, WorktreeMeta>
    getWorkspaceSession?: (hostId?: string) => { activeWorktreeId: string | null } | null
  } = {}
): ScanRuntimeInternals {
  const metaById =
    options.metaById ??
    Object.fromEntries(
      repos.map((repo) => [
        `${repo.id}::${repo.path}`,
        { instanceId: `instance-${repo.id}` } as WorktreeMeta
      ])
    )
  return new OrcaRuntimeService({
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, updates: Partial<WorktreeMeta>) => {
      metaById[id] = { ...metaById[id], ...updates } as WorktreeMeta
      return metaById[id]
    },
    removeWorktreeMeta: (id: string) => {
      delete metaById[id]
    },
    getProjects: () => [],
    getWorkspaceSession: options.getWorkspaceSession
  } as never) as unknown as ScanRuntimeInternals
}

export function strictScansFor(path: string): number {
  return vi.mocked(listWorktreesStrict).mock.calls.filter((call) => call[0] === path).length
}
