// Untracked line counts use Node I/O, so WSL guest paths need Win32 spelling while host paths stay literal.
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as BoundedFileReader from '../../../../shared/file-content/node-bounded-file-reader'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'

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

vi.mock('../../../../shared/file-content/node-bounded-file-reader', async (importOriginal) => {
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

const { numstatCacheInputs } = vi.hoisted(() => {
  type ConfigInputs = { values: Map<string, string>; files: string[]; attributeFiles: string[] }
  type StampInputs = { value: string; newestMtimeMs: number; capturedAtMs: number }
  const state: { config: ConfigInputs | null; stamp: StampInputs | null } = {
    config: null,
    stamp: null
  }
  return { numstatCacheInputs: state }
})

vi.mock('../input-stamps/stamped-git-config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStampedGitConfig: async () => numstatCacheInputs.config
}))

vi.mock('../input-stamps/worktree-diff-stamp', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWorktreePathsDiffStamp: async () => numstatCacheInputs.stamp
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn()
}))

import { attachLineStats } from './status-line-stats'
import { invalidateGitBranchLineTotalInFlight } from '../../../../shared/git/status/git-branch-line-total'
import { settledNumstatCache } from '../git-read-cache-invalidation'

const GUEST_WORKTREE = '/home/me/repo'
const UNC_WORKTREE = String.raw`\\wsl.localhost\Ubuntu\home\me\repo`

function untrackedEntry(entryPath: string): GitStatusEntry {
  return { path: entryPath, area: 'untracked', status: 'added' }
}

describe('untracked line stats on a WSL worktree read by a Windows host', () => {
  beforeEach(() => {
    lstatPaths.length = 0
    untrackedFiles.clear()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('re-spells the guest form only, leaving every host-openable spelling byte-identical', async () => {
    const cases: { worktree: string; expected: string }[] = [
      { worktree: GUEST_WORKTREE, expected: UNC_WORKTREE },
      { worktree: UNC_WORKTREE, expected: UNC_WORKTREE },
      {
        worktree: '//wsl.localhost/Ubuntu/home/me/repo',
        expected: '//wsl.localhost/Ubuntu/home/me/repo'
      },
      { worktree: '/home/me/my repo ', expected: '/home/me/my repo ' }
    ]

    for (const { worktree, expected } of cases) {
      lstatPaths.length = 0
      untrackedFiles.clear()
      const target = path.join(expected, 'fresh.txt')
      untrackedFiles.set(target, 'one\ntwo\n')
      const entries = [untrackedEntry('fresh.txt')]

      await attachLineStats(worktree, entries, { wslDistro: 'Ubuntu' })

      expect(entries[0].added, worktree).toBe(2)
    }
  })
})

describe('unstaged line stats when one file cannot be hashed', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitBranchLineTotalInFlight()
  })

  it('counts the readable rows and leaves only the locked file uncounted', async () => {
    const entries: GitStatusEntry[] = [
      { path: 'src/a.ts', area: 'unstaged', status: 'modified' },
      { path: 'src/locked.db', area: 'unstaged', status: 'modified' },
      { path: 'src/b.ts', area: 'unstaged', status: 'modified' }
    ]
    const diffCalls: string[][] = []
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (!args.includes('--numstat')) {
        return { stdout: '', stderr: '' }
      }
      diffCalls.push(args)
      if (!args.includes('--')) {
        throw new Error('fatal: cannot hash src/locked.db')
      }
      const paths = args.slice(args.indexOf('--') + 1)
      if (paths.includes('src/locked.db')) {
        throw new Error('error: open("src/locked.db"): Permission denied')
      }
      return { stdout: paths.map((path) => `2\t3\t${path}\0`).join(''), stderr: '' }
    })

    // The readable rows still count, but a partial pass must not seed a status snapshot.
    expect(await attachLineStats('/repo', entries)).toBe(false)

    expect(entries[0]).toMatchObject({ added: 2, removed: 3 })
    expect(entries[2]).toMatchObject({ added: 2, removed: 3 })
    expect(entries[1].added).toBeUndefined()
    expect(diffCalls.length).toBeGreaterThan(1)
    expect(diffCalls.slice(1).every((args) => args.includes('--'))).toBe(true)
  })
})

describe('numstat reuse when a path cannot be hashed', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitBranchLineTotalInFlight()
    settledNumstatCache.clear()
    numstatCacheInputs.config = { values: new Map(), files: [], attributeFiles: [] }
    numstatCacheInputs.stamp = {
      value: 'settled-inputs',
      newestMtimeMs: Date.now() - 10_000,
      capturedAtMs: Date.now()
    }
  })

  afterEach(() => {
    numstatCacheInputs.config = null
    numstatCacheInputs.stamp = null
  })

  it('does not cache a partial pass, so the next poll rereads the locked file', async () => {
    let locked = true
    const diffCalls: string[][] = []
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (!args.includes('--numstat')) {
        return { stdout: '', stderr: '' }
      }
      diffCalls.push(args)
      if (!args.includes('--')) {
        throw new Error('fatal: cannot hash src/locked.db')
      }
      const paths = args.slice(args.indexOf('--') + 1)
      if (locked && paths.includes('src/locked.db')) {
        throw new Error('error: open("src/locked.db"): Permission denied')
      }
      return { stdout: paths.map((path) => `2\t3\t${path}\0`).join(''), stderr: '' }
    })
    const entries: GitStatusEntry[] = [
      { path: 'src/a.ts', area: 'unstaged', status: 'modified' },
      { path: 'src/locked.db', area: 'unstaged', status: 'modified' },
      { path: 'src/b.ts', area: 'unstaged', status: 'modified' }
    ]

    // Incomplete: the readable rows are applied, but the pass is neither cached nor published.
    expect(await attachLineStats('/repo', entries)).toBe(false)
    expect(entries[1].added).toBeUndefined()

    locked = false
    expect(await attachLineStats('/repo', entries)).toBe(true)
    expect(entries[1]).toMatchObject({ added: 2, removed: 3 })
    expect(diffCalls.length).toBeGreaterThan(4)
  })

  it('reuses a complete pass without spawning another numstat', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '2\t3\tsrc/a.ts\0', stderr: '' })
    const entries: GitStatusEntry[] = [{ path: 'src/a.ts', area: 'unstaged', status: 'modified' }]

    expect(await attachLineStats('/repo', entries)).toBe(true)
    const callsAfterFirstPass = gitExecFileAsyncMock.mock.calls.length

    expect(await attachLineStats('/repo', entries)).toBe(true)
    expect(gitExecFileAsyncMock.mock.calls.length).toBe(callsAfterFirstPass)
    expect(entries[0]).toMatchObject({ added: 2, removed: 3 })
  })
})
