import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  readCheckedOutBranchRefMock,
  readFileMock,
  readRepoCommonDirFromGitMock,
  readRepoLocationMock,
  readWorktreeHeadOidMock,
  realpathMock,
  statMock
} = vi.hoisted(() => ({
  readCheckedOutBranchRefMock: vi.fn(),
  readFileMock: vi.fn(),
  readRepoCommonDirFromGitMock: vi.fn(),
  readRepoLocationMock: vi.fn(),
  readWorktreeHeadOidMock: vi.fn(),
  realpathMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  realpath: realpathMock,
  stat: statMock
}))
// Only Git is stubbed; the sparse probe below runs for real so the distro has somewhere to matter.
vi.mock('./worktree-list-reader', () => ({
  readCheckedOutBranchRef: readCheckedOutBranchRefMock,
  readRepoCommonDirFromGit: readRepoCommonDirFromGitMock,
  readRepoLocation: readRepoLocationMock,
  readTranslatedWorktreeGraph: vi.fn(),
  readWorktreeHeadOid: readWorktreeHeadOidMock,
  readWorktreeList: vi.fn()
}))

import { describeCreatedWorktree } from './worktree-listing'

const slashed = (value: unknown): string => String(value).replaceAll('\\', '/')
const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

// The layout that needs the caller's distro: the repo lives in the distro, its worktrees on the
// Windows drive. `git worktree list` reports `/mnt/c/wt/x`, which translates to a drive letter that
// no longer names a distro, and the gitfile beside it points at a guest path with no drive to
// derive — so only the distro the create ran under can resolve it.
const REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const GUEST_WORKTREE = '/mnt/c/wt/x'
const HOST_WORKTREE = 'C:/wt/x'
const GUEST_GIT_DIR = '/home/me/repo/.git/worktrees/x'
const HOST_GIT_DIR = '//wsl.localhost/Ubuntu/home/me/repo/.git/worktrees/x'
const HEAD_OID = 'a'.repeat(40)

describe('describeCreatedWorktree on a drvfs-spelled WSL worktree', () => {
  beforeEach(() => {
    readRepoLocationMock.mockReset()
    readRepoLocationMock.mockResolvedValue({
      topLevel: GUEST_WORKTREE,
      commonDir: '/home/me/repo/.git'
    })
    readRepoCommonDirFromGitMock.mockReset()
    readRepoCommonDirFromGitMock.mockResolvedValue('/home/me/repo/.git')
    readCheckedOutBranchRefMock.mockReset()
    readCheckedOutBranchRefMock.mockResolvedValue('refs/heads/feature')
    readWorktreeHeadOidMock.mockReset()
    readWorktreeHeadOidMock.mockResolvedValue(HEAD_OID)
    realpathMock.mockReset()
    realpathMock.mockRejectedValue(missing())
    readFileMock.mockReset()
    readFileMock.mockImplementation(async (target: string) => {
      const value = slashed(target)
      if (value === `${HOST_WORKTREE}/.git`) {
        return `gitdir: ${GUEST_GIT_DIR}\n`
      }
      // No `commondir`, so the gitdir is its own common dir and the config read stays in one
      // namespace — the pointer resolve is the only thing under test.
      if (value === `${HOST_GIT_DIR}/config`) {
        return '[core]\n\tsparseCheckout = true\n'
      }
      throw missing()
    })
    statMock.mockReset()
    statMock.mockImplementation(async (target: string) =>
      slashed(target) === `${HOST_GIT_DIR}/info/sparse-checkout`
        ? { isFile: () => true, size: 12 }
        : Promise.reject(missing())
    )
  })

  it('marks the recovered row sparse through the caller-named distro', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      const described = await describeCreatedWorktree(REPO, 'C:\\wt\\x', 'feature', {
        wslDistro: 'Ubuntu'
      })

      expect(described?.path && slashed(described.path)).toBe(HOST_WORKTREE)
      expect(described?.isSparse).toBe(true)
      expect(statMock.mock.calls.map(([target]) => slashed(target))).toContain(
        `${HOST_GIT_DIR}/info/sparse-checkout`
      )
    } finally {
      platformSpy.mockRestore()
    }
  })
})
