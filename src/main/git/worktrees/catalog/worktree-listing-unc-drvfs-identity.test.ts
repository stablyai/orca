import { settleWslAutomountRoot } from '../../../wsl/filesystem/__fixtures__/wsl-automount-root-fixture'
import { resetWslAutomountRootsForTests } from '../../../wsl/filesystem/wsl-automount-root'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepoMainWorktreeId } from '../../../../shared/worktree/id'

const { gitExecFileAsyncMock, gitExecFileSyncMock, statMock, readFileMock, resolveGitDirMock } =
  vi.hoisted(() => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    statMock: vi.fn(),
    readFileMock: vi.fn(),
    resolveGitDirMock: vi.fn()
  }))

vi.mock('../../../../shared/git/worktrees/git-worktree-admin', () => ({
  annotateWorktreeLocksFromAdmin: async (_repoPath: string, rows: unknown[]) => rows
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../source-control/resolve-git-dir', () => ({
  resolveGitDir: resolveGitDirMock
}))

vi.mock('../../source-control/git-read-cache-invalidation', () => ({
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import { resetWorktreeRemovalState } from '../removal/remove-worktree-test-harness'
import { listWorktreesStrict } from './worktree-listing'
import { readRepoCommonDirFromGit, readRepoLocation } from './worktree-list-reader'
import {
  _resetCanonicalRepoKeyCacheForTests,
  getCanonicalRepoKey
} from '../../repositories/canonical-repo-key'

const REPO_ID = 'repo-1'
const UNC_REPO = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const PORCELAIN =
  'worktree /mnt/c/src/app\0HEAD abc123\0branch refs/heads/main\0\0' +
  'worktree /mnt/c/src/app-feature\0HEAD def456\0branch refs/heads/feature\0\0'

// WSL 2.7.11 refuses Windows access to drive folders through the distro's UNC view.
function eperm(path: unknown): Error {
  return Object.assign(new Error(`EPERM: operation not permitted, '${String(path)}'`), {
    code: 'EPERM'
  })
}

const originalPlatform = process.platform

beforeEach(async () => {
  resetWslAutomountRootsForTests()
  await settleWslAutomountRoot()
  resetWorktreeRemovalState()
  _resetCanonicalRepoKeyCacheForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => ({
    stdout: args.join(' ') === 'worktree list --porcelain -z' ? PORCELAIN : '',
    stderr: ''
  }))
  statMock.mockReset()
  statMock.mockImplementation(async (path: unknown) => {
    throw String(path).startsWith('\\\\') ? eperm(path) : new Error('ENOENT')
  })
  readFileMock.mockReset()
  readFileMock.mockImplementation(async (path: unknown) => {
    throw eperm(path)
  })
  resolveGitDirMock.mockReset()
  resolveGitDirMock.mockImplementation(async (worktreePath: string) => `${worktreePath}\\.git`)
})

afterEach(() => {
  resetWslAutomountRootsForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('listing a UNC drive-folder repo through WSL Git', () => {
  it('keeps the saved UNC spelling, so the primary worktree keeps its saved id', async () => {
    const worktrees = await listWorktreesStrict(UNC_REPO)

    expect(worktrees.map(({ path, isMainWorktree }) => ({ path, isMainWorktree }))).toEqual([
      { path: UNC_REPO, isMainWorktree: true },
      { path: String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app-feature`, isMainWorktree: false }
    ])
    // Tabs, agents and terminal history are keyed by this id; a C:\ spelling orphaned them.
    expect(`${REPO_ID}::${worktrees[0].path}`).toBe(
      getRepoMainWorktreeId({ id: REPO_ID, path: UNC_REPO })
    )
  })

  it('still gives a drive project whose Git runs in WSL its drive paths', async () => {
    const worktrees = await listWorktreesStrict(String.raw`C:\src\app`, { wslDistro: 'Ubuntu' })

    expect(worktrees.map(({ path }) => path)).toEqual([
      String.raw`C:\src\app`,
      String.raw`C:\src\app-feature`
    ])
  })

  it('resolves old-Git relative metadata against the host identity on a custom automount', async () => {
    resetWslAutomountRootsForTests()
    await settleWslAutomountRoot('Ubuntu', '/qamnt/')
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('--show-toplevel')
        ? '--path-format=absolute\n/qamnt/c/src/app\n.git\n.git\n'
        : '--path-format=absolute\n.git\n',
      stderr: ''
    }))
    const cwd = String.raw`C:\src\app`
    await expect(readRepoCommonDirFromGit(cwd, { wslDistro: 'Ubuntu' })).resolves.toBe(
      String.raw`C:\src\app\.git`
    )
    await expect(readRepoLocation(cwd, cwd, { wslDistro: 'Ubuntu' })).resolves.toEqual({
      topLevel: String.raw`C:\src\app`,
      commonDir: String.raw`C:\src\app\.git`,
      gitDir: String.raw`C:\src\app\.git`
    })
    await expect(getCanonicalRepoKey(cwd, { wslDistro: 'Ubuntu' })).resolves.toBe(
      String.raw`wsl:Ubuntu::C:\src\app\.git`
    )
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '/qamnt/c/src/app/.git\n', stderr: '' })
    await expect(
      getCanonicalRepoKey(String.raw`C:\src\app\linked`, { wslDistro: 'Ubuntu' })
    ).resolves.toBe(String.raw`wsl:Ubuntu::C:\src\app\.git`)
  })
})
