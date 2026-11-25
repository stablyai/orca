import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'

const git = vi.hoisted(() => ({ list: vi.fn<(repo: { path: string }) => Promise<unknown>>() }))
vi.mock('../../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreesForDetectedScan: (repo: { path: string }) => git.list(repo)
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../../../runtime/workspaces/catalog/runtime-worktree-scan-cache', () => ({
  resolveWorktreeScanRuntime: () => ({ runtimeKey: 'local:default' })
}))
vi.mock('./worktree-catalog-observation-hygiene', () => ({
  claimWorktreeCatalogHygiene: () => null,
  needsWorktreeCatalogHygieneClaim: () => () => false,
  worktreeCatalogHygienePlan: () => ({})
}))

import {
  invalidateDetectedWorktreeScanCache,
  listDetectedGitWorktrees
} from './detected-worktree-scan-cache'
import { scanUntilNotOvertaken } from './overtaken-scan-rerun'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every store read on this path is mocked above.
const store = {} as Store
let repoSequence = 0
const nextRepo = (): Repo => {
  repoSequence += 1
  return {
    id: `overtaken-${repoSequence}`,
    path: `/repos/overtaken-${repoSequence}`,
    displayName: 'overtaken',
    badgeColor: 'blue',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'local'
  }
}
const rows = (...paths: string[]): GitWorktreeInfo[] =>
  paths.map((path, index) => ({
    path,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: index === 0
  }))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
// The desktop provider's listing core: one adapter read, re-run while overtaken.
const listing = (repo: Repo) =>
  scanUntilNotOvertaken(
    repo.id,
    () => listDetectedGitWorktrees(store, repo),
    () => true
  )

beforeEach(() => {
  git.list.mockReset()
})

describe('a desktop listing after an invalidation', () => {
  it('re-lists when the flight it joined started before the invalidation and failed', async () => {
    const repo = nextRepo()
    const old = deferred<GitWorktreeInfo[]>()
    git.list
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(rows(repo.path, `${repo.path}-selected`))
    const before = listing(repo).catch((error: unknown) => error)
    await vi.waitFor(() => expect(git.list).toHaveBeenCalledTimes(1))
    // A fresh handoff read: the host invalidates, then joins the still-running old flight.
    invalidateDetectedWorktreeScanCache(repo.id)
    const fresh = listing(repo)
    old.reject(new Error('git unavailable'))
    const scan = await fresh
    expect(scan.superseded).toBe(false)
    expect(scan.gitWorktrees.map((worktree) => worktree.path)).toEqual([
      repo.path,
      `${repo.path}-selected`
    ])
    await before
  })

  it('still reports a genuine failure of a current scan', async () => {
    const repo = nextRepo()
    git.list.mockRejectedValueOnce(new Error('git unavailable'))
    await expect(listing(repo)).rejects.toThrow('git unavailable')
    expect(git.list).toHaveBeenCalledTimes(1)
  })

  it('answers a warm catalog until a fresh read observes the new sibling', async () => {
    const repo = nextRepo()
    git.list
      .mockResolvedValueOnce(rows(repo.path))
      .mockResolvedValueOnce(rows(repo.path, `${repo.path}-sibling`))
    expect((await listing(repo)).gitWorktrees).toHaveLength(1)
    // Within the window an ordinary read reuses the warm catalog.
    expect((await listing(repo)).gitWorktrees).toHaveLength(1)
    invalidateDetectedWorktreeScanCache(repo.id)
    expect((await listing(repo)).gitWorktrees).toHaveLength(2)
    expect(git.list).toHaveBeenCalledTimes(2)
  })
})
