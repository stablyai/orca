import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { WORKTREE_CREATE_PREPARATION_DIRECTORY } from '../shared/worktree/create-preparation'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepareCheckout: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  unlock: vi.fn(),
  getWorktreeOptions: vi.fn(),
  computeWorkspaceRoot: vi.fn(),
  computeWorkspaceRootAsync: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepareCheckout,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: mocks.unlock
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getWorktreeOptions,
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('./ipc/worktree-logic', () => ({
  computeWorkspaceRoot: mocks.computeWorkspaceRoot,
  computeWorkspaceRootAsync: mocks.computeWorkspaceRootAsync,
  getWorktreePathSettings: () => ({
    workspaceDir: process.platform === 'win32' ? 'C:\\workspace' : '/workspace',
    nestWorkspaces: false
  })
}))

import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

const repo = { id: 'repo-1', path: '/repo' } as Repo
const store = { getSettings: () => ({}) } as unknown as Store

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepareCheckout.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.unlock.mockReset().mockResolvedValue(undefined)
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
  mocks.computeWorkspaceRoot.mockReset().mockImplementation(() => {
    throw new Error('synchronous workspace-root lookup must not run on the main thread')
  })
  mocks.computeWorkspaceRootAsync
    .mockReset()
    .mockImplementation(async (repoPath: string) =>
      process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(repoPath)
        ? 'C:\\workspace'
        : '/workspace'
    )
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
})

describe('worktree create preparation registry', () => {
  it('starts the checkout only once the async workspace root resolves', async () => {
    let resolveRoot!: (root: string) => void
    mocks.computeWorkspaceRootAsync.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRoot = resolve
      })
    )

    const preparation = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await Promise.resolve()
    expect(mocks.prepareCheckout).not.toHaveBeenCalled()

    resolveRoot('/workspace')
    await preparation

    expect(mocks.computeWorkspaceRoot).not.toHaveBeenCalled()
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('still deduplicates when both callers await the same pending root lookup', async () => {
    let resolveRoot!: (root: string) => void
    mocks.computeWorkspaceRootAsync.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRoot = resolve
      })
    )

    const first = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const second = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    resolveRoot('/workspace')
    await Promise.all([first, second])

    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('namespaces native Windows preparation directories for long paths', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await prepareWorktreeCreateForRepo(store, { ...repo, path: 'C:\\repo' }, 'origin/main')

      expect(mocks.mkdir).toHaveBeenCalledWith(
        expect.stringMatching(/^\\\\\?\\C:\\workspace\\\.orca-preparing/),
        { recursive: true }
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('deduplicates preparation for the same repo, base, runtime, and workspace root', async () => {
    await Promise.all([
      prepareWorktreeCreateForRepo(store, repo, 'origin/main'),
      prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    ])

    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('does not claim a preparation after the selected base changes', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/release'
      })
    ).resolves.toBeNull()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('routes preparation and finalization through the selected WSL runtime', async () => {
    const options = { wslDistro: 'Ubuntu' }
    mocks.getWorktreeOptions.mockReturnValue(options)
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: '/workspace/final',
      branch: 'feature/test',
      baseBranch: 'origin/main',
      options
    })

    expect(mocks.prepareCheckout).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      'origin/main',
      expect.any(String),
      options
    )
    expect(mocks.finalize).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      '/workspace/final',
      'feature/test',
      'origin/main',
      undefined,
      options
    )
  })

  it('retries stale cleanup after a transient listing failure', async () => {
    mocks.listWorktreeGraph.mockRejectedValueOnce(new Error('temporary listing failure'))
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/release')

    expect(mocks.listWorktreeGraph).toHaveBeenCalledTimes(2)
  })

  it('unlocks a stale branch-attached final path instead of deleting user work', async () => {
    mocks.listWorktreeGraph.mockResolvedValueOnce([
      {
        path: '/workspace/final',
        branch: 'refs/heads/feature/test',
        lockReason: 'orca-create-preparation:v1:999999999:stale',
        head: 'deadbeef',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.unlock).toHaveBeenCalledWith(repo.path, '/workspace/final', {})
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, '/workspace/final', {})
  })

  it('does not classify a user branch worktree under the preparation directory as stale', async () => {
    mocks.listWorktreeGraph.mockResolvedValueOnce([
      {
        path: '/workspace/.orca-preparing/999999999-user-worktree',
        branch: 'refs/heads/user-worktree',
        lockReason: undefined,
        head: 'deadbeef',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('does not discard a detached worktree with caller-controlled preparation metadata', async () => {
    mocks.listWorktreeGraph.mockResolvedValueOnce([
      {
        path: `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/999-checkout`,
        branch: undefined,
        lockReason: 'orca-create-preparation:v1:999999999:spoofed',
        head: 'deadbeef',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.discard).not.toHaveBeenCalledWith(
      repo.path,
      `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/999-checkout`,
      {}
    )
  })

  it('cleans up and returns null so normal add can run when finalization fails', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.finalize.mockRejectedValueOnce(new Error('submodules prevent worktree move'))

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toBeNull()
    expect(mocks.mkdir).toHaveBeenCalledWith('/workspace', { recursive: true })
    expect(mocks.discard).toHaveBeenCalledTimes(1)
  })
})
