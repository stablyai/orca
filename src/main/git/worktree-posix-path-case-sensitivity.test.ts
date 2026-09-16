/**
 * A case-sensitive filesystem stays case-sensitive whichever desktop is reading it.
 * `git/worktree-path-comparison` decided case-folding from `process.platform`, so on Windows both
 * spellings of a WSL checkout — the Linux one and the `\\wsl.localhost\...` alias the listing
 * actually produces — folded, and two distinct checkouts read as one row.
 *
 * The removal suite mocks `translateWslOutputPaths` to identity. That mock is what hid this: in
 * production `listWorktreesStrict` always runs the listing through it, so the paths that reach the
 * comparison are UNC, never Linux. The end-to-end case below therefore drives the real translator.
 */
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslPathTranslation from './command-runner/wsl-path-translation'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  statMock,
  readFileMock,
  resolveGitDirMock,
  moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletionMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn(),
  moveWorktreeDirectoryToTrashMock: vi.fn(),
  restoreWorktreeDirectoryFromTrashMock: vi.fn(),
  scheduleWorktreeTrashDeletionMock: vi.fn()
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrash: restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletion: scheduleWorktreeTrashDeletionMock
}))

// Why the real translator: an identity mock removes the Linux -> UNC rewrite that production
// always applies, which is the only reason the Linux spelling would ever reach the comparison.
vi.mock('./runner', async () => {
  const translation = await vi.importActual<typeof WslPathTranslation>(
    './command-runner/wsl-path-translation'
  )
  return {
    gitExecFileAsync: gitExecFileAsyncMock,
    gitExecFileSync: gitExecFileSyncMock,
    translateWslOutputPaths: translation.translateWslOutputPaths
  }
})

vi.mock('./status', () => ({
  resolveGitDir: resolveGitDirMock,
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import {
  createGitCallReader,
  createGitCommandMocker,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'
import { areWorktreePathsEqual, canonicalWorktreePath } from './worktree-path-comparison'
import { removeWorktree } from './worktree'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\ws'

describe('worktree path comparison across path syntaxes', () => {
  it('keeps two WSL UNC worktrees that differ only in case distinct', () => {
    expect(areWorktreePathsEqual(`${UNC}\\Feature`, `${UNC}\\feature`, 'win32')).toBe(false)
    expect(canonicalWorktreePath(`${UNC}\\Feature`, 'win32')).not.toBe(
      canonicalWorktreePath(`${UNC}\\feature`, 'win32')
    )
  })

  it('keeps two POSIX worktrees that differ only in case distinct on a Windows desktop', () => {
    expect(areWorktreePathsEqual('/home/alice/ws/Feature', '/home/alice/ws/feature', 'win32')).toBe(
      false
    )
  })

  it('still folds the share alias, the distro name and the slash style, which Windows folds', () => {
    expect(
      areWorktreePathsEqual(
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\wt',
        '//WSL$/ubuntu/home/alice/wt',
        'win32'
      )
    ).toBe(true)
  })

  it('still folds a drvfs tail, which really is a Windows volume', () => {
    expect(
      areWorktreePathsEqual(
        '\\\\wsl$\\Ubuntu\\mnt\\C\\Users\\Jin',
        '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\users\\jin',
        'win32'
      )
    ).toBe(true)
  })

  it('does not fold a distro directory that merely looks like the drvfs mount', () => {
    expect(
      areWorktreePathsEqual(
        '\\\\wsl$\\Ubuntu\\MNT\\c\\Repo',
        '\\\\wsl$\\Ubuntu\\MNT\\c\\repo',
        'win32'
      )
    ).toBe(false)
  })

  it('collapses dot segments in both case-sensitive syntaxes', () => {
    expect(areWorktreePathsEqual(`${UNC}\\.\\feature`, `${UNC}\\x\\..\\feature`, 'win32')).toBe(true)
    expect(
      areWorktreePathsEqual('/home/alice/ws/./feature', '/home/alice/ws/x/../feature', 'win32')
    ).toBe(true)
  })

  it('still folds Windows drive paths by case and slash style', () => {
    expect(areWorktreePathsEqual('C:/Users/Bob/wt', 'c:\\Users\\bob\\wt', 'win32')).toBe(true)
    expect(areWorktreePathsEqual('C:/Users/Bob/wt', 'c:\\Users\\bob\\wt', 'darwin')).toBe(true)
  })

  it('never equates paths written in different syntaxes', () => {
    expect(areWorktreePathsEqual('/home/alice/wt', `${UNC}\\..\\wt`, 'win32')).toBe(false)
    expect(areWorktreePathsEqual('/Users/bob/wt', 'C:\\Users\\bob\\wt', 'win32')).toBe(false)
    expect(areWorktreePathsEqual(`${UNC}\\wt`, 'C:\\ws\\wt', 'win32')).toBe(false)
  })
})

describe('removeWorktree branch selection on a Windows desktop', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    statMock.mockReset()
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    readFileMock.mockReset()
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    resolveGitDirMock.mockReset()
    resetWorktreeRemovalState({
      moveWorktreeDirectoryToTrashMock,
      restoreWorktreeDirectoryFromTrashMock,
      scheduleWorktreeTrashDeletionMock
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('deletes the branch of the requested WSL worktree, not its case twin', async () => {
    // Git-in-the-distro answers in Linux paths; the real translator rewrites them to UNC on the way
    // out, so this is the exact listing the comparison sees on a Windows desktop.
    const listing = `worktree /home/alice/repo
HEAD aaa111
branch refs/heads/main

worktree /home/alice/ws/Feature
HEAD bbb222
branch refs/heads/Feature

worktree /home/alice/ws/feature
HEAD ccc333
branch refs/heads/feature
`
    mockGitCommands({
      'git worktree list --porcelain -z': { stdout: listing },
      'git worktree list --porcelain': { stdout: listing }
    })

    await removeWorktree(
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo',
      `${UNC}\\feature`,
      true,
      { wslDistro: 'Ubuntu' }
    )

    const calls = getGitCalls()
    expect(calls).toContain('git branch -d -- feature')
    expect(calls).not.toContain('git branch -d -- Feature')
  })
})
