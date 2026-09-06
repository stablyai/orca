import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, statMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  stat: statMock
}))

import { readWorktreeDiffStamp } from './source-control/worktree-diff-stamp'

const slashed = (value: unknown): string => String(value).replaceAll('\\', '/')
const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

// Why this file: git in a WSL distro reports the worktree as `/mnt/c/...`, and the gitdir resolve
// reaches it on its own. If the working-tree read did not travel the same way, the stamp would be
// built from a real HEAD and a permanently absent file — a settled diff that survives every edit.
describe('readWorktreeDiffStamp on a drvfs-spelled WSL worktree', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    statMock.mockReset()
    readFileMock.mockImplementation(async (target: string) => {
      const value = slashed(target)
      if (value === 'C:/repo/wt/.git') {
        return 'gitdir: /mnt/c/repo/.git/worktrees/wt\n'
      }
      // Detached HEAD, so the stamp needs no ref-store walk.
      if (value === 'C:/repo/.git/worktrees/wt/HEAD') {
        return `${'a'.repeat(40)}\n`
      }
      throw missing()
    })
    statMock.mockImplementation(async (target: string) =>
      slashed(target) === 'C:/repo/wt/src/a.ts'
        ? { mtimeMs: 1_000, size: 12, ino: 7 }
        : Promise.reject(missing())
    )
  })

  it('stamps the working-tree file through the same host spelling as the gitdir', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      const stamp = await readWorktreeDiffStamp('/mnt/c/repo/wt', 'src/a.ts', true)

      expect(stamp).not.toBeNull()
      expect(statMock.mock.calls.map(([target]) => slashed(target))).toContain(
        'C:/repo/wt/src/a.ts'
      )
      // The working-tree component is what moves when the user edits, so it has to be present.
      expect(stamp?.newestMtimeMs).toBe(1_000)
    } finally {
      platformSpy.mockRestore()
    }
  })
})
