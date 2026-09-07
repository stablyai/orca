import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, statMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock, stat: statMock }))

import { readWorktreeDiffStamp } from './source-control/worktree-diff-stamp'

const slashed = (value: unknown): string => String(value).replaceAll('\\', '/')
const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

// A worktree on the Windows drive whose repo lives in the distro's own filesystem: the worktree
// resolves to a drive letter, so the gitdir pointer beside it — which is not drvfs — has no
// drive to derive and needs the distro the diff read already carries.
const HOST_WORKTREE = 'C:/wt/x'
const GUEST_GIT_DIR = '/home/me/repo/.git/worktrees/x'
const HOST_GIT_DIR = '//wsl.localhost/Ubuntu/home/me/repo/.git/worktrees/x'

describe('readWorktreeDiffStamp with a non-drvfs gitdir pointer', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    statMock.mockReset()
    readFileMock.mockImplementation(async (target: string) => {
      const value = slashed(target)
      if (value === `${HOST_WORKTREE}/.git`) {
        return `gitdir: ${GUEST_GIT_DIR}\n`
      }
      // Detached HEAD, so the stamp needs no ref-store walk.
      if (value === `${HOST_GIT_DIR}/HEAD`) {
        return `${'a'.repeat(40)}\n`
      }
      throw missing()
    })
    statMock.mockImplementation(async (target: string) =>
      slashed(target) === `${HOST_WORKTREE}/src/a.ts`
        ? { mtimeMs: 1_000, size: 12, ino: 7 }
        : Promise.reject(missing())
    )
  })

  it('resolves the gitdir through the caller-named distro so the diff stays cacheable', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      const stamp = await readWorktreeDiffStamp('/mnt/c/wt/x', 'src/a.ts', true, {
        wslDistro: 'Ubuntu'
      })

      // Null here means "cannot prove unchanged", which is what an unreadable HEAD produces —
      // correct, but it retires the settled-diff cache for every file in the worktree.
      expect(stamp).not.toBeNull()
      expect(stamp?.newestMtimeMs).toBe(1_000)
    } finally {
      platformSpy.mockRestore()
    }
  })
})
