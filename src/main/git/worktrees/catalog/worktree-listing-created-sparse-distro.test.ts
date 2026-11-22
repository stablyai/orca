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
// Keep the sparse probe real so namespace routing is exercised.
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

// A drive-spelled checkout loses the distro needed to resolve its non-drvfs gitdir pointer.
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
      // Omit commondir to isolate pointer resolution from common-dir traversal.
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

  it('uses the repo disk witness in the WSL execution namespace', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    readRepoCommonDirFromGitMock.mockResolvedValue('/other/.git')
    statMock.mockImplementation(async (target: string) => {
      const value = slashed(target)
      if (value === `${slashed(REPO)}/.git`) {
        return { isDirectory: () => true }
      }
      if (value === `${HOST_GIT_DIR}/info/sparse-checkout`) {
        return { isFile: () => true, size: 12 }
      }
      throw missing()
    })

    try {
      await expect(
        describeCreatedWorktree(REPO, 'C:\\wt\\x', 'feature', { wslDistro: 'Ubuntu' })
      ).resolves.toMatchObject({ branch: 'refs/heads/feature' })
    } finally {
      platformSpy.mockRestore()
    }
  })
})
