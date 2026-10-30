import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from './wsl'
import type { Repo } from '../shared/repo-types'

const { mkdirMock, getWslHomeMock, getWslHomeAsyncMock, runningStateMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  getWslHomeMock: vi.fn(),
  getWslHomeAsyncMock: vi.fn(),
  runningStateMock: vi.fn(async (_distro: string, _options?: unknown) => 'running')
}))

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock
}))

vi.mock('./wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getWslHome: getWslHomeMock,
  getWslHomeAsync: getWslHomeAsyncMock
}))

vi.mock('./wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: runningStateMock
}))

import {
  prepareLocalWorktreeRootForRepo,
  prepareLocalWorktreeRootsForRepos
} from './worktree-root-preparation'

const repo: Repo = {
  id: 'repo-1',
  path: '/projects/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}

const store = {
  getSettings: vi.fn()
}

describe('prepareLocalWorktreeRootForRepo', () => {
  beforeEach(() => {
    mkdirMock.mockReset().mockResolvedValue(undefined)
    getWslHomeMock.mockReset().mockImplementation(() => {
      throw new Error('synchronous wsl.exe home probe must not run on the main thread')
    })
    getWslHomeAsyncMock.mockReset().mockResolvedValue(null)
    runningStateMock.mockReset().mockResolvedValue('running')
    store.getSettings.mockReset().mockReturnValue({
      workspaceDir: '/Users/alice/orca/workspaces',
      nestWorkspaces: false
    })
  })

  it('creates the effective worktree root for local git repos', async () => {
    await prepareLocalWorktreeRootForRepo(store as never, repo)

    expect(mkdirMock).toHaveBeenCalledWith('/Users/alice/orca/workspaces', { recursive: true })
  })

  it('resolves a WSL repo root through the async probe instead of blocking on wsl.exe', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    let resolveHome!: (home: string) => void
    getWslHomeAsyncMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveHome = resolve
      })
    )
    store.getSettings.mockReturnValue({ workspaceDir: 'C:\\workspaces', nestWorkspaces: false })

    try {
      const preparation = prepareLocalWorktreeRootForRepo(store as never, {
        ...repo,
        path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo'
      })
      await Promise.resolve()
      expect(mkdirMock).not.toHaveBeenCalled()

      resolveHome('\\\\wsl.localhost\\Ubuntu\\home\\jin')
      await preparation

      expect(getWslHomeMock).not.toHaveBeenCalled()
      expect(mkdirMock).toHaveBeenCalledWith(
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\orca\\workspaces',
        { recursive: true }
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('uses repo-specific worktree base paths', async () => {
    await prepareLocalWorktreeRootForRepo(store as never, {
      ...repo,
      worktreeBasePath: '../worktrees'
    })

    expect(mkdirMock).toHaveBeenCalledWith('/projects/worktrees', { recursive: true })
  })

  it('skips non-local and folder repos', async () => {
    await prepareLocalWorktreeRootForRepo(store as never, { ...repo, connectionId: 'ssh-1' })
    await prepareLocalWorktreeRootForRepo(store as never, {
      ...repo,
      executionHostId: 'ssh:ssh-1'
    })
    await prepareLocalWorktreeRootForRepo(store as never, {
      ...repo,
      executionHostId: 'runtime:env-1'
    })
    await prepareLocalWorktreeRootForRepo(store as never, { ...repo, kind: 'folder' })

    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('does not fail repo setup when root preparation fails', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('permission denied'))

    await expect(prepareLocalWorktreeRootForRepo(store as never, repo)).resolves.toBeUndefined()
  })

  // G8: a workspaceDir edit fans out to every repo; it must not boot a stopped distro's home probe.
  it('skips a WSL repo whose distro is stopped when preparing every root', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    runningStateMock.mockResolvedValue('stopped')
    store.getSettings.mockReturnValue({ workspaceDir: 'C:\\workspaces', nestWorkspaces: false })
    const wslRepo = { ...repo, id: 'repo-2', path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo' }

    try {
      await prepareLocalWorktreeRootsForRepos({ ...store, getRepos: () => [repo, wslRepo] })

      expect(runningStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
      expect(getWslHomeAsyncMock).not.toHaveBeenCalled()
      expect(mkdirMock).toHaveBeenCalledTimes(1)
      expect(mkdirMock).not.toHaveBeenCalledWith(expect.stringContaining('wsl.localhost'), {
        recursive: true
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
