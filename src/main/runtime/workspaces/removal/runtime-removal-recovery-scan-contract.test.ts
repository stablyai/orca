import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'

const { scan, nativeGraph } = vi.hoisted(() => ({ scan: vi.fn(), nativeGraph: vi.fn() }))
vi.mock('../../../git/worktrees/catalog/worktree-list-reader', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readTranslatedWorktreeGraph: nativeGraph
}))
vi.mock('../../../git/worktrees/catalog/worktree-listing', () => ({
  listWorktreesStrict: scan,
  listWorktreeGraph: vi.fn(),
  annotateSparseCheckoutStatus: vi.fn()
}))
vi.mock('../../../git/worktrees/removal/worktree-removal', () => ({
  finishUnregisteredWorktreeRemoval: async () => ({}),
  deleteBranchOfUnregisteredWorktree: vi.fn(),
  removeWorktree: vi.fn()
}))
vi.mock('../../../ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: async () => {}
}))
vi.mock('./runtime-registered-local-worktree-removal', () => ({
  cleanupRemovedWorktreePushTarget: async () => {},
  finishRuntimeLocalWorktreeRemoval: vi.fn()
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'
import {
  _resetWorktreeScanCacheForTests,
  bumpWorktreeScanGeneration
} from '../../../git/worktrees/catalog/worktree-scan-cache'
import { _resetPendingWorktreeRemovalsForTests } from '../../../workspaces/removal/worktree-background-removal'

afterEach(() => {
  _resetPendingWorktreeRemovalsForTests()
  _resetWorktreeScanCacheForTests()
  scan.mockReset()
  nativeGraph.mockReset()
})
function record(index: number, repoId: string): WorktreeRemovalRecord {
  return {
    worktreeId: `${repoId}::${index}`,
    repoId,
    repoPath: `/missing/${repoId}`,
    worktreePath: `/missing/${repoId}/checkout-${index}`,
    branch: 'feature',
    head: 'abc',
    force: false,
    deleteBranch: false,
    requestedAt: 1
  }
}
function host(repos: Repo[]) {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: interrupted cleanup consumes only these repo and metadata reads; physical Git mutations are isolated below the scan seam.
    store: {
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getWorktreeMeta: () => undefined
    } as unknown as RuntimeStore,
    acquireWatcherRemoval: vi.fn(async () => ({ finish: async () => {} })),
    stopPtys: vi.fn(async () => {}),
    closeWatchers: async () => {},
    preservedBranchCleanup: { preserveHead: () => ({}), remember: () => {} },
    purge: vi.fn(async (_record: WorktreeRemovalRecord) => {}),
    onRemoved: vi.fn(),
    publish: () => {}
  }
}

it('obtains a fresh inventory after a catalog generation changes and protects the replacement checkout', async () => {
  const saved = record(0, 'repo-0')
  const runtime = host([
    { id: 'repo-0', path: saved.repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 }
  ])
  let release!: () => void
  const oldInventory = new Promise<GitWorktreeInfo[]>((resolve) => {
    release = () => resolve([])
  })
  scan.mockReturnValueOnce(oldInventory).mockResolvedValueOnce([
    {
      path: saved.worktreePath,
      branch: 'replacement',
      head: 'def',
      isMainWorktree: false,
      isBare: false
    }
  ])
  const signal = new AbortController().signal
  const first = interruptedLocalWorktreeRemovalJob(saved, runtime).run(signal)
  bumpWorktreeScanGeneration(saved.repoPath)
  const replacement = interruptedLocalWorktreeRemovalJob(saved, runtime).run(signal)
  await expect(replacement).rejects.toThrow('A different checkout is now at')
  expect(scan).toHaveBeenCalledTimes(2)
  expect(runtime.purge).not.toHaveBeenCalled()
  release()
  await first
})
