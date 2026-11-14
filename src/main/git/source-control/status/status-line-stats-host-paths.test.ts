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

import { attachLineStats } from './status-line-stats'

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
