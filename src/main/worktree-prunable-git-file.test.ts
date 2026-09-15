import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { isPrunableGitFileWorktree } from './worktree-prunable-git-file'

const { statPath, pathAccess, runtimePath } = vi.hoisted(() => ({
  statPath: vi.fn(),
  pathAccess: vi.fn(),
  runtimePath: vi.fn()
}))

vi.mock('./local-worktree-filesystem', () => ({
  getLocalWorktreePathAccess: pathAccess,
  toLocalWorktreeRuntimePath: runtimePath
}))

const worktree: GitWorktreeInfo = {
  path: '/workspaces/feature/.git',
  branch: 'refs/heads/feature',
  head: 'a'.repeat(40),
  isMainWorktree: false,
  isBare: false,
  prunable: true
}

beforeEach(() => {
  vi.resetAllMocks()
  statPath.mockResolvedValue({ isFile: () => true })
  pathAccess.mockReturnValue({ statPath })
  runtimePath.mockImplementation((path) => path)
})

describe('prunable Git-file registration proof', () => {
  it('accepts an attested named-branch file without reading or changing its parent', async () => {
    await expect(isPrunableGitFileWorktree(worktree)).resolves.toBe(true)
    expect(statPath).toHaveBeenCalledExactlyOnceWith(worktree.path)
  })
  it.each([
    { prunable: false },
    { prunable: undefined },
    { isMainWorktree: true },
    { isBare: true },
    { locked: true },
    { branch: '' },
    { branch: 'refs/tags/feature' },
    { branch: 'refs/heads/' },
    { head: '' },
    { path: '/workspaces/feature' }
  ])('refuses insufficient registration evidence %j', async (override) => {
    await expect(isPrunableGitFileWorktree({ ...worktree, ...override })).resolves.toBe(false)
    expect(statPath).not.toHaveBeenCalled()
  })
  it.each([{ isFile: () => false }, { type: 'directory' }, { type: 'symlink' }, {}, null])(
    'refuses non-file or unknown filesystem evidence %j',
    async (entry) => {
      statPath.mockResolvedValue(entry)
      await expect(isPrunableGitFileWorktree(worktree)).resolves.toBe(false)
    }
  )
  it('leaves a vanished marker to existing missing-path recovery', async () => {
    statPath.mockRejectedValue(Object.assign(new Error('marker vanished'), { code: 'ENOENT' }))
    await expect(isPrunableGitFileWorktree(worktree)).resolves.toBe(false)
  })
  it('does not turn host failure into cleanup permission', async () => {
    statPath.mockRejectedValue(new Error('host unavailable'))
    await expect(isPrunableGitFileWorktree(worktree)).rejects.toThrow('host unavailable')
  })
  it('uses the selected WSL distro and translated execution path', async () => {
    const options = { wslDistro: 'Ubuntu' }
    runtimePath.mockReturnValue('/home/dev/feature/.git')
    statPath.mockResolvedValue({ type: 'file' })
    await expect(
      isPrunableGitFileWorktree({ ...worktree, path: 'C:\\workspaces\\feature\\.git' }, options)
    ).resolves.toBe(true)
    expect(pathAccess).toHaveBeenCalledExactlyOnceWith(options)
    expect(runtimePath).toHaveBeenCalledWith('C:\\workspaces\\feature\\.git', options)
    expect(statPath).toHaveBeenCalledExactlyOnceWith('/home/dev/feature/.git')
  })
})
