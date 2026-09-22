/**
 * Untracked line counts come from direct lstat/open calls, not from git, so on a Windows host
 * driving a WSL distro they must be issued against the Win32 spelling of the worktree. These
 * assert the exact path that reaches the filesystem: translated for a guest-rooted worktree,
 * verbatim for one that is already spelled in this process's own namespace.
 */
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import type { GitStatusEntry } from '../../shared/git-status-types'
import { invalidateGitBranchLineTotalInFlight } from '../../shared/git-branch-line-total'

const { lstatPaths, untrackedFiles } = vi.hoisted(() => ({
  lstatPaths: [] as string[],
  untrackedFiles: new Map<string, string>()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    lstat: async (target: string) => {
      lstatPaths.push(target)
      const contents = untrackedFiles.get(target)
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
      }
      return {
        size: Buffer.byteLength(contents),
        // Distinct per read so the stat-keyed untracked cache never serves another case's entry.
        mtimeMs: lstatPaths.length,
        ctimeMs: lstatPaths.length,
        isSymbolicLink: () => false,
        isFile: () => true
      }
    }
  }
})

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof BoundedFileReader>()
  return {
    ...actual,
    readNodeFileWithinLimit: async (target: string) => {
      const contents = untrackedFiles.get(target)
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
      }
      return { buffer: Buffer.from(contents) }
    }
  }
})

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn(),
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => env,
  gitStreamStdout: vi.fn()
}))

import { attachLineStats } from './source-control/status-line-stats'
import { createBranchLineTotalInput } from './source-control/status-branch-line-total-input'

const GUEST_WORKTREE = '/home/me/repo'
const UNC_WORKTREE = String.raw`\\wsl.localhost\Ubuntu\home\me\repo`
const MERGE_BASE = 'a'.repeat(40)

function untrackedEntry(entryPath: string): GitStatusEntry {
  return { path: entryPath, area: 'untracked', status: 'added' }
}

describe('untracked line stats on a WSL worktree read by a Windows host', () => {
  beforeEach(() => {
    lstatPaths.length = 0
    untrackedFiles.clear()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    invalidateGitBranchLineTotalInFlight()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('counts an untracked file through the distro UNC spelling of the worktree', async () => {
    const target = path.join(UNC_WORKTREE, 'fresh.txt')
    untrackedFiles.set(target, 'one\ntwo\nthree\n')
    const entries = [untrackedEntry('fresh.txt')]

    const complete = await attachLineStats(GUEST_WORKTREE, entries, { wslDistro: 'Ubuntu' })

    expect(lstatPaths).toEqual([target])
    expect(entries[0].added).toBe(3)
    expect(complete).toBe(true)
  })

  it('adds untracked lines to the branch total through the same spelling', async () => {
    const target = path.join(UNC_WORKTREE, 'fresh.txt')
    untrackedFiles.set(target, 'one\ntwo\nthree\n')
    const input = createBranchLineTotalInput(
      GUEST_WORKTREE,
      [untrackedEntry('fresh.txt')],
      { wslDistro: 'Ubuntu', branchLineTotalMergeBase: MERGE_BASE },
      true
    )

    const total = await input?.compute()

    expect(lstatPaths).toEqual([target])
    expect(total?.added).toBe(3)
  })

  it('maps a drvfs worktree onto its drive spelling', async () => {
    const target = path.join(String.raw`C:\repo`, 'fresh.txt')
    untrackedFiles.set(target, 'one\n')
    const entries = [untrackedEntry('fresh.txt')]

    await attachLineStats('/mnt/c/repo', entries, { wslDistro: 'Ubuntu' })

    expect(lstatPaths).toEqual([target])
    expect(entries[0].added).toBe(1)
  })

  // One case per spelling in a single test: the guest row pins that re-spelling still happens, so
  // the whole test dies if the production hunks are reverted, and each verbatim row pins one half
  // of the guard that keeps a path this process can already open from being re-spelt onto nothing.
  it('re-spells the guest form only, leaving every host-openable spelling byte-identical', async () => {
    const cases: { worktree: string; expected: string }[] = [
      { worktree: GUEST_WORKTREE, expected: UNC_WORKTREE },
      { worktree: UNC_WORKTREE, expected: UNC_WORKTREE },
      {
        worktree: '//wsl.localhost/Ubuntu/home/me/repo',
        expected: '//wsl.localhost/Ubuntu/home/me/repo'
      },
      { worktree: '//wsl$/Ubuntu/home/me/repo', expected: '//wsl$/Ubuntu/home/me/repo' },
      { worktree: '/home/me/my repo ', expected: '/home/me/my repo ' }
    ]

    for (const { worktree, expected } of cases) {
      lstatPaths.length = 0
      untrackedFiles.clear()
      const target = path.join(expected, 'fresh.txt')
      untrackedFiles.set(target, 'one\ntwo\n')
      const entries = [untrackedEntry('fresh.txt')]

      await attachLineStats(worktree, entries, { wslDistro: 'Ubuntu' })

      expect(lstatPaths, worktree).toEqual([target])
      expect(entries[0].added, worktree).toBe(2)
    }
  })
})
