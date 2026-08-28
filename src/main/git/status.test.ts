import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import {
  createBoundedFileReaderModuleMock,
  createFsPromisesModuleMock,
  createGitRunnerModuleMock
} from './status-test-harness'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  gitStreamOptionsMock,
  lstatMock,
  realpathMock,
  readFileMock,
  statMock,
  rmMock,
  accessMock,
  existsSyncMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn(),
  accessMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({
    lstatMock,
    realpathMock,
    readFileMock,
    statMock,
    rmMock,
    accessMock
  })
)

// Why still here: unmerged-entry parsing probes the working tree through node:fs directly.
vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { clearEffectiveUpstreamStatusCacheForTests, getStatus, stageFile } from './status'

describe('getStatus', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    gitStreamOptionsMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReset()
    accessMock.mockReset()
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    // Why: untracked line counting stats a file before reading it; any
    // under-limit size routes the read to readFileMock.
    statMock.mockReset()
    statMock.mockResolvedValue({ isFile: () => true, size: 12 })
    // Why: after the status call, getStatus may issue `git diff --numstat`
    // calls to attach per-entry line counts. Tests that don't care about counts
    // set only a `mockResolvedValueOnce` for the status output; this default
    // keeps those follow-up numstat calls from returning undefined.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
  })

  it('parses unmerged porcelain v2 entries into unresolved conflict rows', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    accessMock.mockImplementation(async (target: string) => {
      if (target.endsWith('MERGE_HEAD')) {
        return undefined
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc src/app.ts\n'
    })

    const result = await getStatus('/repo')

    expect(result.conflictOperation).toBe('merge')
    expect(result.entries).toEqual([
      {
        path: 'src/app.ts',
        area: 'unstaged',
        status: 'modified',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved'
      }
    ])
  })

  it('maps deleted conflicts to deleted when the working tree file is absent', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'u UD N... 100644 100644 000000 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc src/deleted.ts\n'
    })

    const result = await getStatus('/repo')

    expect(result.entries[0]).toEqual({
      path: 'src/deleted.ts',
      area: 'unstaged',
      status: 'deleted',
      conflictKind: 'deleted_by_them',
      conflictStatus: 'unresolved'
    })
  })

  it('falls back to modified when the filesystem existence check throws', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockImplementation(() => {
      throw new Error('stat failed')
    })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'u AU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc src/new.ts\n'
    })

    const result = await getStatus('/repo')

    expect(result.entries[0]?.status).toBe('modified')
    expect(result.entries[0]?.conflictKind).toBe('added_by_us')
  })

  it('passes core.quotePath=false and round-trips UTF-8 paths', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '1 .M N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a ce013625030ba8dba906f756967f9e9ca394464a docs/日本語/sample.md\n'
    })

    const result = await getStatus('/repo')

    // Why: without -c core.quotePath=false git would emit
    // "docs/\346\227\245\346\234\254\350\252\236/sample.md" (octal-escaped,
    // wrapped in double quotes) and the parser would store that literal
    // string as entry.path, breaking sidebar display + downstream blob reads.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith([
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ])
    expect(result.entries).toEqual([
      { path: 'docs/日本語/sample.md', status: 'modified', area: 'unstaged' }
    ])
  })

  it('preserves porcelain v2 submodule dirtiness flags on status rows', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '1 AM S..U 000000 160000 160000 0000000000000000000000000000000000000000 7844cb64e631f17a9ca5b548f3500ef7cecd2f17 nested-repo\n'
    })

    const result = await getStatus('/repo')

    expect(result.entries).toEqual([
      {
        path: 'nested-repo',
        status: 'added',
        area: 'staged',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
      },
      {
        path: 'nested-repo',
        status: 'modified',
        area: 'unstaged',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
      }
    ])
  })

  it('omits ignored files by default and parses them when requested', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '! dist/\n! generated/file.js\n'
    })

    const result = await getStatus('/repo', { includeIgnored: true })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith([
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '--ignored=matching'
    ])
    expect(result.ignoredPaths).toEqual(['dist/', 'generated/file.js'])
  })

  it('parses branch identity from porcelain v2 branch headers', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '# branch.oid abcdef1234567890\n# branch.head feature/prompts\n1 .M N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a ce013625030ba8dba906f756967f9e9ca394464a src/app.ts\n'
    })

    const result = await getStatus('/repo')

    expect(result).toMatchObject({
      head: 'abcdef1234567890',
      branch: 'refs/heads/feature/prompts'
    })
  })

  it('folds upstream ahead/behind from porcelain v2 into the status result', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '# branch.oid abcdef1234567890\n# branch.head feature/prompts\n# branch.upstream origin/feature/prompts\n# branch.ab +2 -3\n'
    })

    const result = await getStatus('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(result.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature/prompts',
      ahead: 2,
      behind: 3
    })
  })

  it('reports no upstream from porcelain v2 status when no same-name origin branch exists', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === '-c' && args.includes('status')) {
        return Promise.resolve({
          stdout: '# branch.oid abcdef1234567890\n# branch.head feature/prompts\n'
        })
      }
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature/prompts\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature/prompts')) {
        return Promise.reject(new Error('missing remote branch'))
      }
      if (args[0] === 'config') {
        return Promise.reject(new Error(`missing ${args[2] ?? 'config'}`))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getStatus('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature/prompts'],
      { cwd: '/repo', preferWslDirectGit: true }
    )
    expect(result.upstreamStatus).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
  })

  it('uses same-name origin branch status for legacy base-tracking worktrees', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout:
          '# branch.oid abcdef1234567890\n# branch.head feature/prompts\n# branch.upstream origin/main\n# branch.ab +1 -0\n'
      })
      .mockResolvedValueOnce({ stdout: 'feature/prompts\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: 'abc123\n' })
      .mockResolvedValueOnce({ stdout: '3\t1\n' })

    const result = await getStatus('/repo')

    expect(result.upstreamStatus).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature/prompts',
      ahead: 3,
      behind: 1
    })
  })

  it('omits --ignored and ignoredPaths when includeIgnored is not requested', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    const result = await getStatus('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith([
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ])
    expect('ignoredPaths' in result).toBe(false)
  })

  it('parses ! porcelain v2 records into ignoredPaths when includeIgnored is true', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '! dist/\n! .env\n! coverage/\n'
    })

    const result = await getStatus('/repo', { includeIgnored: true })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith([
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '--ignored=matching'
    ])
    expect(result.ignoredPaths).toEqual(['dist/', '.env', 'coverage/'])
    expect(result.entries).toEqual([])
  })

  it('attaches per-area line counts from staged and unstaged numstat', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout:
            '1 M. N... 100644 100644 100644 aaaa aaaa src/staged.ts\n' +
            '1 .M N... 100644 100644 100644 bbbb bbbb src/unstaged.ts\n'
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({
          stdout: args.includes('--cached') ? '10\t0\tsrc/staged.ts\n' : '3\t4\tsrc/unstaged.ts\n'
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await getStatus('/repo')

    expect(result.entries).toEqual([
      { path: 'src/staged.ts', status: 'modified', area: 'staged', added: 10, removed: 0 },
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged', added: 3, removed: 4 }
    ])
  })

  it('reuses unchanged line stats only when the safety hint is present', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout:
            '# branch.oid head-1\n' + '1 .M N... 100644 100644 100644 aaaa aaaa src/unstaged.ts\n'
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '3\t4\tsrc/unstaged.ts\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    await getStatus('/repo')
    const reused = await getStatus('/repo', { reuseLineStats: true })
    await getStatus('/repo')

    expect(reused.entries).toEqual([
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged', added: 3, removed: 4 }
    ])
    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args.includes('--numstat'))
    ).toHaveLength(2)
  })

  it('recomputes after a scan whose numstat failed instead of pinning missing counts', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    let failNumstat = true
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout:
            '# branch.oid head-1\n' + '1 .M N... 100644 100644 100644 aaaa aaaa src/unstaged.ts\n'
        })
      }
      if (args.includes('--numstat')) {
        if (failNumstat) {
          failNumstat = false
          return Promise.reject(new Error('transient index.lock'))
        }
        return Promise.resolve({ stdout: '3\t4\tsrc/unstaged.ts\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const failed = await getStatus('/repo')
    const reused = await getStatus('/repo', { reuseLineStats: true })

    expect(failed.entries[0]?.added).toBeUndefined()
    expect(reused.entries).toEqual([
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged', added: 3, removed: 4 }
    ])
  })

  it('invalidates safety reuse for a new head and for known mutations', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    let head = 'head-1'
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout:
            `# branch.oid ${head}\n` + '1 .M N... 100644 100644 100644 aaaa aaaa src/unstaged.ts\n'
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '3\t4\tsrc/unstaged.ts\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    await getStatus('/repo')
    head = 'head-2'
    await getStatus('/repo', { reuseLineStats: true })
    await stageFile('/repo', 'src/unstaged.ts')
    await getStatus('/repo', { reuseLineStats: true })

    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args.includes('--numstat'))
    ).toHaveLength(3)
  })

  it('isolates line-stat reuse between WSL distributions', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout: '1 .M N... 100644 100644 100644 aaaa aaaa src/unstaged.ts\n'
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '3\t4\tsrc/unstaged.ts\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    await getStatus('/repo', { wslDistro: 'ubuntu' })
    await getStatus('/repo', { wslDistro: 'debian', reuseLineStats: true })
    await getStatus('/repo', { wslDistro: 'ubuntu', reuseLineStats: true })

    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args.includes('--numstat'))
    ).toHaveLength(2)
  })

  it('attaches numstat counts for literal paths containing rename markers', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout: '1 .M N... 100644 100644 100644 aaaa aaaa docs/a => b.txt\n'
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '1\t0\tdocs/a => b.txt\0' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await getStatus('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' })
      })
    )
    expect(result.entries).toEqual([
      { path: 'docs/a => b.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 }
    ])
  })

  it('attaches staged rename counts to the new path', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout: '2 R. N... 100644 100644 100644 aaaa bbbb R100 src/new name.ts\tsrc/old name.ts\n'
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '2\t1\tsrc/old name.ts => src/new name.ts\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await getStatus('/repo')

    expect(result.entries).toEqual([
      {
        path: 'src/new name.ts',
        oldPath: 'src/old name.ts',
        status: 'renamed',
        area: 'staged',
        added: 2,
        removed: 1
      }
    ])
  })

  it('counts untracked file contents as additions', async () => {
    lstatMock.mockResolvedValue({
      size: 14,
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => true,
      isSymbolicLink: () => false
    })
    readFileMock.mockImplementation((target: string) =>
      String(target).endsWith('.git')
        ? Promise.resolve('gitdir: /repo/.git/worktrees/feature\n')
        : Promise.resolve(Buffer.from('one\ntwo\nthree\n'))
    )
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '? src/brand-new.ts\n' })

    const result = await getStatus('/repo')

    expect(result.entries).toEqual([
      { path: 'src/brand-new.ts', status: 'untracked', area: 'untracked', added: 3 }
    ])
  })

  it('leaves binary working-tree changes without counts', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({
          stdout: '1 .M N... 100644 100644 100644 cccc cccc assets/logo.png\n'
        })
      }
      // git reports binary files as '-' in both numstat columns.
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '-\t-\tassets/logo.png\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await getStatus('/repo')

    expect(result.entries).toEqual([
      { path: 'assets/logo.png', status: 'modified', area: 'unstaged' }
    ])
  })

  it('skips numstat entirely for a clean working tree', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await getStatus('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('truncates and flags didHitLimit when entries exceed the limit', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    const stdout = `${Array.from({ length: 25 }, (_, i) => `? file${i}.txt`).join('\n')}\n`
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout })

    const result = await getStatus('/repo', { limit: 10 })

    expect(result.didHitLimit).toBe(true)
    expect(result.statusLength).toBeGreaterThan(10)
    // First `limit` entries are kept; the rest are dropped.
    expect(result.entries.length).toBe(10)
    // attachLineStats (numstat) must be skipped when the limit was hit — only
    // the single streamed status read should have happened.
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('caps unmerged conflicts and keeps the visible conflict rows', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(true)
    const lines = [
      'u UU S... 160000 160000 160000 160000 aa bb cc vendor/submodule',
      ...Array.from(
        { length: 3 },
        (_, i) => `u UU N... 100644 100644 100644 100644 aa bb cc conflict-${i}.ts`
      )
    ].join('\n')
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${lines}\n` })

    const result = await getStatus('/repo', { limit: 2 })

    expect(result.didHitLimit).toBe(true)
    expect(result.statusLength).toBe(3)
    expect(result.entries).toHaveLength(2)
    expect(result.entries.map((entry) => entry.path)).toEqual(['conflict-0.ts', 'conflict-1.ts'])
    expect(result.entries.every((entry) => entry.conflictStatus === 'unresolved')).toBe(true)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('keeps an early conflict ahead of later ordinary rows at the cap', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(true)
    const lines = [
      '? before.ts',
      'u UU N... 100644 100644 100644 100644 aa bb cc conflict.ts',
      '? after.ts'
    ].join('\n')
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${lines}\n` })

    const result = await getStatus('/repo', { limit: 2 })

    expect(result.didHitLimit).toBe(true)
    expect(result.entries.map((entry) => entry.path)).toEqual(['before.ts', 'conflict.ts'])
    expect(result.entries[1]).toMatchObject({
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved'
    })
  })

  it('does not flag didHitLimit for a normal repo under the limit', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '? a.txt\n? b.txt\n' })

    const result = await getStatus('/repo', { limit: 10 })

    expect(result.didHitLimit).toBeUndefined()
    expect(result.entries.length).toBe(2)
  })
})
