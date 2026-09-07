import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: () => '/tmp/orca-test' }
}))
vi.mock('../../../git/runner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

const { listDetectedWorktreesForCapturedRepo } = await import('./detected-provider-listing')
const { __resetDetectedWorktreeScanCacheForTests } = await import('./detected-worktree-scan-cache')
const { _resetWorktreeScanCacheForTests } = await import('../../../git/worktree-scan-cache')
const { isRegisteredWorktreePath, invalidateAuthorizedRootsCache } =
  await import('../../registered-worktree-roots-cache')

const REPO_PATH = '/workspace/repo'
const repo = {
  id: 'repo-1',
  path: REPO_PATH,
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
} as Repo

const removeWorktreeLineage = vi.fn()

function createStore() {
  return {
    getRepo: () => repo,
    getRepos: () => [repo],
    getProjects: () => [],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getProjectHostSetups: () => [],
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage,
    captureNativeLocalWorktreeMetadataScanExpectation: () => undefined
  } as never
}

/** The field failure: wsl.exe exits 0xFFFFFFFF, says nothing on stderr, and git never ran. */
function wslHostFailure(): Error {
  return Object.assign(new Error('Command failed: wsl.exe -d kali-linux --exec sh -lc ...'), {
    code: 4294967295,
    stdout: 'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n',
    stderr: ''
  })
}

async function listDetected(): Promise<DetectedWorktreeListResult> {
  const result = await listDetectedWorktreesForCapturedRepo(createStore(), repo, () => true)
  return result as DetectedWorktreeListResult
}

describe('detected worktree listing authority', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    removeWorktreeLineage.mockReset()
    __resetDetectedWorktreeScanCacheForTests()
    _resetWorktreeScanCacheForTests()
    invalidateAuthorizedRootsCache()
  })

  it('reports a failed scan as non-authoritative and prunes nothing', async () => {
    gitExecFileAsyncMock.mockRejectedValue(wslHostFailure())

    const result = await listDetected()

    expect(result.authoritative).toBe(false)
    expect(result.source).toBe('metadata-fallback')
    expect(result.worktrees).toEqual([])
    // Why: the retained rows must carry the cause, or the user sees inert worktrees with no explanation.
    expect(result.unavailableReason).toContain('Command failed: wsl.exe')
    // The destructive halves of a fresh scan must not run against a listing that failed.
    expect(isRegisteredWorktreePath(REPO_PATH)).toBe(false)
    expect(removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('surfaces the annotated wsl.exe diagnostic as the unavailable reason', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(
        new Error(
          'wsl.exe host failure (distro "kali-linux"): There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\nCommand failed: wsl.exe -d kali-linux --exec sh -lc ...'
        ),
        { code: 4294967295, stdout: '', stderr: '' }
      )
    )

    const result = await listDetected()

    expect(result.authoritative).toBe(false)
    expect(result.unavailableReason).toBe(
      'wsl.exe host failure (distro "kali-linux"): There is no distribution with the supplied name. Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
    )
  })

  // Why (measured on a real Windows host): under WSL the spawn cwd is the interop directory, so a
  // deleted guest repo fails as `bash: cd` exit 1 — not ENOENT — and must stay retained, not pruned.
  it('retains a WSL repo whose guest directory is gone, and says why', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('bash: line 1: cd: /home/neil/repo: No such file or directory'), {
        code: 1,
        stdout: '',
        stderr: 'bash: line 1: cd: /home/neil/repo: No such file or directory\n'
      })
    )

    const result = await listDetected()

    expect(result.authoritative).toBe(false)
    expect(result.unavailableReason).toContain('No such file or directory')
    expect(isRegisteredWorktreePath(REPO_PATH)).toBe(false)
    expect(removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('keeps an empty listing authoritative when the path is not a Git repo', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('Command failed: git worktree list'), {
        code: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )

    const result = await listDetected()

    expect(result.authoritative).toBe(true)
    expect(result.source).toBe('git')
    expect(result.worktrees).toEqual([])
    expect(result.unavailableReason).toBeUndefined()
    expect(isRegisteredWorktreePath(REPO_PATH)).toBe(true)
  })

  it('keeps an empty listing authoritative when the repo path is gone', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT', stderr: '' })
    )

    const result = await listDetected()

    expect(result.authoritative).toBe(true)
    expect(result.source).toBe('git')
    expect(result.worktrees).toEqual([])
  })

  it('stays authoritative for a healthy scan', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: `worktree ${REPO_PATH}\u0000HEAD abc\u0000branch refs/heads/main\u0000\u0000`,
      stderr: ''
    })

    const result = await listDetected()

    expect(result.authoritative).toBe(true)
    expect(result.worktrees.map((worktree) => worktree.path)).toEqual([REPO_PATH])
    expect(isRegisteredWorktreePath(REPO_PATH)).toBe(true)
  })
})
