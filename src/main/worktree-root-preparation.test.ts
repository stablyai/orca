import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/types'

const { mkdirMock, authorizeExternalPathMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  authorizeExternalPathMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock
}))

vi.mock('./ipc/filesystem-auth', () => ({
  authorizeExternalPath: authorizeExternalPathMock
}))

import { prepareLocalWorktreeRootForRepo } from './worktree-root-preparation'

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
    authorizeExternalPathMock.mockReset()
    store.getSettings.mockReset().mockReturnValue({
      workspaceDir: '/Users/alice/orca/workspaces',
      nestWorkspaces: false
    })
  })

  it('creates the effective worktree root for local git repos', async () => {
    await prepareLocalWorktreeRootForRepo(store as never, repo)

    expect(mkdirMock).toHaveBeenCalledWith('/Users/alice/orca/workspaces', { recursive: true })
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
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
  })

  it('does not fail repo setup when root preparation fails', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('permission denied'))

    await expect(prepareLocalWorktreeRootForRepo(store as never, repo)).resolves.toBeUndefined()
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
  })
})
