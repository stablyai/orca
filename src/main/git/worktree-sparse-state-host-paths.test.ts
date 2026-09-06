import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, statMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock, stat: statMock }))

import { detectSparseCheckout } from './worktree-sparse-state'

const slashed = (value: unknown): string => String(value).replaceAll('\\', '/')
const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

// The layout that needs the caller's distro: `git worktree list` reports a drvfs worktree, which
// translates to a drive letter, so the base path no longer names the distro that wrote the gitdir
// pointer — and that pointer is not itself drvfs, so there is nothing to derive a drive from.
const HOST_WORKTREE = 'C:/wt/x'
const GUEST_GIT_DIR = '/home/me/repo/.git/worktrees/x'
const HOST_GIT_DIR = '//wsl.localhost/Ubuntu/home/me/repo/.git/worktrees/x'

describe('detectSparseCheckout on a drvfs-spelled WSL worktree', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    statMock.mockReset()
    readFileMock.mockImplementation(async (target: string) => {
      const value = slashed(target)
      if (value === `${HOST_WORKTREE}/.git`) {
        return `gitdir: ${GUEST_GIT_DIR}\n`
      }
      // No `commondir`, so the gitdir is its own common dir and the config read stays in one
      // namespace — the pointer resolve above is the only thing under test.
      if (value === `${HOST_GIT_DIR}/config`) {
        return '[core]\n\tsparseCheckout = true\n'
      }
      throw missing()
    })
    statMock.mockImplementation(async (target: string) =>
      slashed(target) === `${HOST_GIT_DIR}/info/sparse-checkout`
        ? { isFile: () => true, size: 12 }
        : Promise.reject(missing())
    )
  })

  it('reads the pattern file through the caller-named distro', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      await expect(detectSparseCheckout('/mnt/c/wt/x', { wslDistro: 'Ubuntu' })).resolves.toBe(true)
      expect(statMock.mock.calls.map(([target]) => slashed(target))).toContain(
        `${HOST_GIT_DIR}/info/sparse-checkout`
      )
    } finally {
      platformSpy.mockRestore()
    }
  })
})
