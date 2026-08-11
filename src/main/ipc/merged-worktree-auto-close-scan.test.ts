import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { GitWorktreeInfo, Repo } from '../../shared/types'
import { MERGED_WORKTREE_AUTO_CLOSE_MIN_AGE_MS } from '../../shared/merged-worktree-auto-close'

const {
  listRepoWorktreesMock,
  getLocalProjectWorktreeGitOptionsMock,
  getStatusMock,
  isWorktreeBranchMergedIntoBaseMock,
  hasWorktreeBranchUpstreamConfiguredMock
} = vi.hoisted(() => ({
  listRepoWorktreesMock: vi.fn(),
  getLocalProjectWorktreeGitOptionsMock: vi.fn(),
  getStatusMock: vi.fn(),
  isWorktreeBranchMergedIntoBaseMock: vi.fn(),
  hasWorktreeBranchUpstreamConfiguredMock: vi.fn()
}))

vi.mock('../repo-worktrees', () => ({
  createFolderWorktree: vi.fn(),
  listRepoWorktrees: listRepoWorktreesMock
}))

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

vi.mock('../git/status', () => ({ getStatus: getStatusMock }))

vi.mock('../git/worktree-branch-merge-state', () => ({
  isWorktreeBranchMergedIntoBase: isWorktreeBranchMergedIntoBaseMock,
  hasWorktreeBranchUpstreamConfigured: hasWorktreeBranchUpstreamConfiguredMock
}))

import { scanMergedWorktreeAutoCloseCandidates } from './merged-worktree-auto-close-scan'

const NOW = 1_800_000_000_000
const CREATED_AT = NOW - MERGED_WORKTREE_AUTO_CLOSE_MIN_AGE_MS - 1

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
}

function gitWorktree(overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path: '/workspaces/feature',
    head: 'aaaaaaa',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

function createStore(overrides: Partial<Store> = {}): Store {
  return {
    getWorktreeMeta: () => ({ createdAt: CREATED_AT }),
    ...overrides
  } as unknown as Store
}

beforeEach(() => {
  listRepoWorktreesMock.mockReset().mockResolvedValue([gitWorktree()])
  getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
  getStatusMock.mockReset().mockResolvedValue({ entries: [] })
  isWorktreeBranchMergedIntoBaseMock.mockReset().mockResolvedValue(true)
  hasWorktreeBranchUpstreamConfiguredMock.mockReset().mockResolvedValue(true)
})

describe('scanMergedWorktreeAutoCloseCandidates', () => {
  it('closes a merged, clean, published workspace', async () => {
    const decisions = await scanMergedWorktreeAutoCloseCandidates(createStore(), REPO, { now: NOW })

    expect(decisions).toEqual([
      {
        worktreeId: 'repo-1::/workspaces/feature',
        repoId: 'repo-1',
        path: '/workspaces/feature',
        branch: 'feature',
        action: 'close'
      }
    ])
    expect(isWorktreeBranchMergedIntoBaseMock).toHaveBeenCalledWith(
      '/repo',
      'feature',
      expect.objectContaining({ timeout: expect.any(Number) })
    )
  })

  it('keeps an unmerged workspace and never reads its status', async () => {
    isWorktreeBranchMergedIntoBaseMock.mockResolvedValue(false)

    const decisions = await scanMergedWorktreeAutoCloseCandidates(createStore(), REPO, { now: NOW })

    expect(decisions[0]).toMatchObject({ action: 'skip', reason: 'not-merged' })
    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('keeps a merged workspace with uncommitted changes', async () => {
    getStatusMock.mockResolvedValue({ entries: [{ path: 'src/a.ts' }] })

    const decisions = await scanMergedWorktreeAutoCloseCandidates(createStore(), REPO, { now: NOW })

    expect(decisions[0]).toMatchObject({ action: 'skip', reason: 'dirty-files' })
  })

  it('never probes Git for the primary checkout', async () => {
    listRepoWorktreesMock.mockResolvedValue([
      gitWorktree({ path: '/repo', branch: 'refs/heads/main', isMainWorktree: true })
    ])

    const decisions = await scanMergedWorktreeAutoCloseCandidates(createStore(), REPO, { now: NOW })

    expect(decisions[0]).toMatchObject({ action: 'skip', reason: 'main-worktree' })
    expect(hasWorktreeBranchUpstreamConfiguredMock).not.toHaveBeenCalled()
    expect(isWorktreeBranchMergedIntoBaseMock).not.toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('keeps a workspace whose status could not be read', async () => {
    getStatusMock.mockRejectedValue(new Error('git status exploded'))

    const decisions = await scanMergedWorktreeAutoCloseCandidates(createStore(), REPO, { now: NOW })

    expect(decisions[0]).toMatchObject({ action: 'skip', reason: 'status-check-failed' })
  })

  it('skips SSH-backed repos entirely', async () => {
    const decisions = await scanMergedWorktreeAutoCloseCandidates(
      createStore(),
      { ...REPO, connectionId: 'ssh-1' },
      { now: NOW }
    )

    expect(decisions).toEqual([])
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
  })

  it('returns no decisions when the worktree list fails', async () => {
    listRepoWorktreesMock.mockRejectedValue(new Error('git worktree list exploded'))

    await expect(
      scanMergedWorktreeAutoCloseCandidates(createStore(), REPO, { now: NOW })
    ).resolves.toEqual([])
  })

  it('passes the project WSL distro to the merge probe', async () => {
    getLocalProjectWorktreeGitOptionsMock.mockReturnValue({ wslDistro: 'Ubuntu' })

    await scanMergedWorktreeAutoCloseCandidates(createStore(), REPO, { now: NOW })

    expect(hasWorktreeBranchUpstreamConfiguredMock).toHaveBeenCalledWith(
      '/repo',
      'feature',
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
  })
})
