/* eslint-disable max-lines -- Why: git status/discard/chunking behavior is verified together here to keep the command contract readable in one place. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  lstatMock,
  realpathMock,
  readFileMock,
  statMock,
  rmMock,
  existsSyncMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: gitExecFileAsyncBufferMock,
  // Why: getStatus now streams status output. The mock pulls the next queued
  // stdout from gitExecFileAsyncMock and feeds it to onStdout, so existing tests
  // that seed the status call via `gitExecFileAsyncMock.mockResolvedValueOnce`
  // keep working unchanged and call ordering (status, then numstat) is preserved.
  gitStreamStdout: async (
    args: string[],
    options: { onStdout: (chunk: string) => boolean | void }
  ) => {
    // Forward args so arg-routing mock implementations (e.g. `args.includes`)
    // still match the status read.
    const { stdout } = await gitExecFileAsyncMock(args)
    const stoppedEarly = options.onStdout(stdout ?? '') === true
    return { stoppedEarly }
  },
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  })
}))

vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  realpath: realpathMock,
  readFile: readFileMock,
  stat: statMock,
  rm: rmMock
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

import {
  abortMerge,
  abortRebase,
  bulkStageFiles,
  bulkDiscardChanges,
  bulkUnstageFiles,
  clearEffectiveUpstreamStatusCacheForTests,
  detectConflictOperation,
  discardChanges,
  getBranchCompare,
  getCommitCompare,
  getDiff,
  getStagedCommitContext,
  getStatus,
  isWithinWorktree
} from './status'

describe('discardChanges', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    lstatMock.mockReset()
    realpathMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
    lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    realpathMock.mockImplementation(async (targetPath: string) => path.resolve(targetPath))
  })

  it('restores tracked files from HEAD', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'src/file.ts\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await discardChanges('/repo', 'src/file.ts')

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['ls-files', '--error-unmatch', '--', ':(literal)src/file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['restore', '--worktree', '--source=HEAD', '--', ':(literal)src/file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('removes untracked files from disk', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not tracked'))

    await discardChanges('/repo', 'src/new-file.ts')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['clean', '-ffdx', '--', ':(literal)src/new-file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('rejects paths that traverse outside the worktree', async () => {
    await expect(discardChanges('/repo', '../../etc/passwd')).rejects.toThrow(
      'resolves outside the worktree'
    )

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('accepts in-tree Windows paths when resolving containment', async () => {
    expect(isWithinWorktree(path.win32, 'C:\\repo', 'C:\\repo\\src\\file.ts')).toBe(true)
  })
})

describe('bulk git helpers', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    lstatMock.mockReset()
    realpathMock.mockReset()
    rmMock.mockReset()
    lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    realpathMock.mockImplementation(async (targetPath: string) => path.resolve(targetPath))
  })

  it('chunks bulk stage requests to avoid oversized argv payloads', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    const filePaths = Array.from({ length: 201 }, (_, i) => `src/file-${i}.ts`)
    await bulkStageFiles('/repo', filePaths)

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['add', '--', ...filePaths.slice(0, 100).map((filePath) => `:(literal)${filePath}`)],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['add', '--', ...filePaths.slice(200).map((filePath) => `:(literal)${filePath}`)],
      {
        cwd: '/repo'
      }
    )
  })

  it('chunks bulk unstage requests to avoid oversized argv payloads', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    const filePaths = Array.from({ length: 101 }, (_, i) => `src/file-${i}.ts`)
    await bulkUnstageFiles('/repo', filePaths)

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'restore',
        '--staged',
        '--',
        ...filePaths.slice(100).map((filePath) => `:(literal)${filePath}`)
      ],
      {
        cwd: '/repo'
      }
    )
  })

  it('discards tracked and untracked paths in bulk', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'src/file.ts\0docs/readme.md\0' })
      .mockResolvedValueOnce({ stdout: '' })

    await bulkDiscardChanges('/repo', ['src/file.ts', 'src/new-file.ts', 'docs', 'scratch'])

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'ls-files',
        '-z',
        '--',
        ':(literal)src/file.ts',
        ':(literal)src/new-file.ts',
        ':(literal)docs',
        ':(literal)scratch'
      ],
      {
        cwd: '/repo'
      }
    )
    // Why: a pathspec is tracked if git reports either the exact path or a
    // tracked descendant, which keeps directory pathspecs on the restore path.
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['restore', '--worktree', '--source=HEAD', '--', ':(literal)src/file.ts', ':(literal)docs'],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['clean', '-ffdx', '--', ':(literal)src/new-file.ts', ':(literal)scratch'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('handles large tracked path lists during bulk discard classification', async () => {
    const trackedStdout = Array.from({ length: 150_000 }, (_, index) => `docs/file-${index}.ts`)
      .join('\0')
      .concat('\0')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: trackedStdout }).mockResolvedValueOnce({
      stdout: ''
    })

    await bulkDiscardChanges('/repo', ['docs'])

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['restore', '--worktree', '--source=HEAD', '--', ':(literal)docs'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('rejects bulk discard paths that traverse outside the worktree', async () => {
    await expect(bulkDiscardChanges('/repo', ['src/file.ts', '../outside.txt'])).rejects.toThrow(
      'resolves outside the worktree'
    )

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })
})

describe('getDiff', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    statMock.mockReset()
    existsSyncMock.mockReset()
    statMock.mockResolvedValue({
      isFile: () => true,
      size: 12
    })
  })

  it('uses the index as the left side for unstaged diffs when present', async () => {
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from('index-content\n') })
    readFileMock.mockResolvedValue(Buffer.from('working-tree-content'))

    const result = await getDiff('/repo', 'src/file.ts', false)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledWith(['show', ':src/file.ts'], {
      cwd: '/repo',
      maxBuffer: 10 * 1024 * 1024
    })
    expect(readFileMock).toHaveBeenCalledWith(path.join('/repo', 'src/file.ts'))
    expect(result).toEqual({
      kind: 'text',
      originalContent: 'index-content\n',
      modifiedContent: 'working-tree-content',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
  })

  it('normalizes Windows separators before reading git blobs', async () => {
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from('index-content\n') })
    readFileMock.mockResolvedValue(Buffer.from('working-tree-content'))

    await getDiff('/repo', 'src\\file.ts', false)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledWith(['show', ':src/file.ts'], {
      cwd: '/repo',
      maxBuffer: 10 * 1024 * 1024
    })
  })

  it('falls back to HEAD for unstaged diffs when the file is not in the index', async () => {
    gitExecFileAsyncBufferMock
      .mockRejectedValueOnce(new Error('missing index'))
      .mockResolvedValueOnce({ stdout: Buffer.from('head-content\n') })
    readFileMock.mockResolvedValue(Buffer.from('working-tree-content'))

    const result = await getDiff('/repo', 'src/file.ts', false)

    expect(gitExecFileAsyncBufferMock).toHaveBeenNthCalledWith(
      2,
      ['show', '--end-of-options', 'HEAD:src/file.ts'],
      {
        cwd: '/repo',
        maxBuffer: 10 * 1024 * 1024
      }
    )
    expect(result.originalContent).toBe('head-content\n')
    expect(result.modifiedContent).toBe('working-tree-content')
  })

  it('marks binary content in the diff payload', async () => {
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from([0x00, 0x61, 0x62]) })
    readFileMock.mockResolvedValue(Buffer.from('working-tree-content'))

    const result = await getDiff('/repo', 'src/file.bin', false)

    expect(result.kind).toBe('binary')
    expect(result.originalIsBinary).toBe(true)
    expect(result.modifiedIsBinary).toBe(false)
  })

  it('does not read oversized working-tree files into memory', async () => {
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from('index-content\n') })
    statMock.mockResolvedValueOnce({
      isFile: () => true,
      size: 10 * 1024 * 1024 + 1
    })

    const result = await getDiff('/repo', 'dist/large.log', false)

    expect(readFileMock).not.toHaveBeenCalled()
    expect(result.kind).toBe('binary')
    expect(result.modifiedIsBinary).toBe(true)
    expect(result.modifiedContent).toBe('')
  })

  it('includes preview metadata for pdf diffs', async () => {
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00])
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: pdfBuffer })
    readFileMock.mockResolvedValue(pdfBuffer)

    const result = await getDiff('/repo', 'docs/spec.pdf', false)

    expect(result).toEqual({
      kind: 'binary',
      originalContent: pdfBuffer.toString('base64'),
      modifiedContent: pdfBuffer.toString('base64'),
      originalIsBinary: true,
      modifiedIsBinary: true,
      isImage: true,
      mimeType: 'application/pdf'
    })
  })
})

describe('getStatus', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReset()
    // Why: after the status call, getStatus may issue `git diff --numstat`
    // calls to attach per-entry line counts. Tests that don't care about counts
    // set only a `mockResolvedValueOnce` for the status output; this default
    // keeps those follow-up numstat calls from returning undefined.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
  })

  it('parses unmerged porcelain v2 entries into unresolved conflict rows', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockImplementation((target: string) => target.endsWith('MERGE_HEAD'))
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: '# branch.oid abcdef1234567890\n# branch.head feature/prompts\n'
      })
      .mockResolvedValueOnce({ stdout: 'feature/prompts\n' })
      .mockRejectedValueOnce(new Error('fatal: no upstream configured'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getStatus('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(result.upstreamStatus).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
  })

  it('uses same-name origin branch status for legacy base-tracking worktrees', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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

  it('attaches numstat counts for literal paths containing rename markers', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
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
      { cwd: '/repo', env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }) }
    )
    expect(result.entries).toEqual([
      { path: 'docs/a => b.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 }
    ])
  })

  it('attaches staged rename counts to the new path', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await getStatus('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('truncates and flags didHitLimit when entries exceed the limit', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
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

  it('does not flag didHitLimit for a normal repo under the limit', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '? a.txt\n? b.txt\n' })

    const result = await getStatus('/repo', { limit: 10 })

    expect(result.didHitLimit).toBeUndefined()
    expect(result.entries.length).toBe(2)
  })
})

describe('abortMerge', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('runs git merge --abort in the worktree', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await abortMerge('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['merge', '--abort'], { cwd: '/repo' })
  })
})

describe('abortRebase', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('runs git rebase --abort in the worktree', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await abortRebase('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rebase', '--abort'], { cwd: '/repo' })
  })
})

describe('getStagedCommitContext', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('uses explicit large buffers before prompt truncation', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature/ai\n' })
      .mockResolvedValueOnce({ stdout: 'M\tREADME.md\n' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/README.md b/README.md\n+hello\n' })

    const result = await getStagedCommitContext('/repo')

    expect(result).toEqual({
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: 'diff --git a/README.md b/README.md\n+hello\n'
    })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['diff', '--cached', '--name-status'], {
      cwd: '/repo',
      maxBuffer: 10 * 1024 * 1024
    })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
      {
        cwd: '/repo',
        maxBuffer: 10 * 1024 * 1024
      }
    )
  })

  it('falls back to the file summary when the staged patch overflows the buffer', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature/ai\n' })
      .mockResolvedValueOnce({ stdout: 'A\thuge.jsonl\n' })
      .mockRejectedValueOnce(
        Object.assign(new Error('stdout maxBuffer length exceeded'), {
          code: 'ENOBUFS'
        })
      )

    const result = await getStagedCommitContext('/repo')

    expect(result).toEqual({
      branch: 'feature/ai',
      stagedSummary: 'A\thuge.jsonl',
      stagedPatch: ''
    })
  })

  it('rethrows staged patch failures that are not buffer overflows', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature/ai\n' })
      .mockResolvedValueOnce({ stdout: 'M\tREADME.md\n' })
      .mockRejectedValueOnce(new Error('fatal: bad revision'))

    await expect(getStagedCommitContext('/repo')).rejects.toThrow('fatal: bad revision')
  })
})

describe('detectConflictOperation', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    existsSyncMock.mockReset()
  })

  it('ignores a stale REBASE_HEAD when no rebase directory exists', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockImplementation((target: string) => {
      if (target.endsWith('MERGE_HEAD')) {
        return false
      }
      if (target.endsWith('CHERRY_PICK_HEAD')) {
        return false
      }
      if (target.endsWith('rebase-merge')) {
        return false
      }
      if (target.endsWith('rebase-apply')) {
        return false
      }
      if (target.endsWith('REBASE_HEAD')) {
        return true
      }
      return false
    })

    const result = await detectConflictOperation('/repo')

    expect(result).toBe('unknown')
  })
})

describe('getBranchCompare', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    readFileMock.mockReset()
  })

  it('returns a pinned branch compare snapshot and parsed branch entries', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'remote-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'head-oid\n' })
      .mockResolvedValueOnce({ stdout: 'base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({
        stdout: 'M\tfile-a.ts\nR100\told-name.ts\tnew-name.ts\nC100\told-copy.ts\tnew-copy.ts\n'
      })
      .mockResolvedValueOnce({
        stdout:
          '10\t2\tfile-a.ts\n1\t1\told-name.ts => new-name.ts\n3\t0\told-copy.ts => new-copy.ts\n'
      })
      .mockResolvedValueOnce({ stdout: '7\n' })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary).toEqual({
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      compareRef: 'main',
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      changedFiles: 3,
      commitsAhead: 7,
      status: 'ready'
    })
    expect(result.entries).toEqual([
      { path: 'file-a.ts', status: 'modified', added: 10, removed: 2 },
      { path: 'new-name.ts', oldPath: 'old-name.ts', status: 'renamed', added: 1, removed: 1 },
      { path: 'new-copy.ts', oldPath: 'old-copy.ts', status: 'copied', added: 3, removed: 0 }
    ])
  })

  it('returns invalid-base when the compare ref does not resolve', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockRejectedValueOnce(new Error('missing remote base'))
      .mockRejectedValueOnce(new Error('missing local base'))
      .mockResolvedValueOnce({ stdout: 'head-oid\n' })
      .mockRejectedValueOnce(new Error('missing base'))

    const result = await getBranchCompare('/repo', 'origin/missing')

    expect(result.summary.status).toBe('invalid-base')
    expect(result.summary.errorMessage).toContain('origin/missing')
    expect(result.entries).toEqual([])
  })

  it('returns unborn-head when HEAD cannot be resolved', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'remote-base-oid\n' })
      .mockRejectedValueOnce(new Error('unborn'))
      .mockRejectedValueOnce(new Error('missing base'))

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary.status).toBe('unborn-head')
    expect(result.summary.errorMessage).toContain('committed HEAD')
    expect(result.entries).toEqual([])
  })

  it('treats an unborn branch with a resolvable base as having no committed branch changes', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'remote-base-oid\n' })
      .mockRejectedValueOnce(new Error('unborn'))
      .mockResolvedValueOnce({ stdout: 'base-oid\n' })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary).toEqual({
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      compareRef: 'feature',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready'
    })
    expect(result.entries).toEqual([])
  })

  it('returns no-merge-base when histories do not intersect', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'remote-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'head-oid\n' })
      .mockResolvedValueOnce({ stdout: 'base-oid\n' })
      .mockRejectedValueOnce(new Error('no merge base'))

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary.status).toBe('no-merge-base')
    expect(result.summary.errorMessage).toContain('merge base')
    expect(result.entries).toEqual([])
  })

  it('passes core.quotePath=false to diff --name-status and parses UTF-8 paths', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'remote-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'head-oid\n' })
      .mockResolvedValueOnce({ stdout: 'base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'M\tdocs/日本語/sample.md\n' })
      .mockResolvedValueOnce({ stdout: '2\t1\tdocs/日本語/sample.md\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      6,
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-status',
        '-M',
        '-C',
        'merge-base-oid',
        'head-oid'
      ],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(result.entries).toEqual([
      { path: 'docs/日本語/sample.md', status: 'modified', added: 2, removed: 1 }
    ])
  })

  it('compares short remote labels through fully qualified remote-tracking refs', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (
        args[0] === 'rev-parse' &&
        args.includes('--quiet') &&
        args.includes('refs/remotes/origin/main^{commit}')
      ) {
        return Promise.resolve({ stdout: 'remote-base-oid\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return Promise.resolve({ stdout: 'head-oid\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
        return Promise.resolve({ stdout: 'base-oid\n' })
      }
      if (args[0] === 'merge-base') {
        return Promise.resolve({ stdout: 'merge-base-oid\n' })
      }
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: '' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary).toMatchObject({
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      status: 'ready'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main'],
      { cwd: '/repo' }
    )
  })

  it('attaches counts for branch compare paths containing rename markers', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: 'main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return Promise.resolve({ stdout: 'head-oid\n' })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'base-oid\n' })
      }
      if (args[0] === 'merge-base') {
        return Promise.resolve({ stdout: 'merge-base-oid\n' })
      }
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: 'M\tdocs/a => b.txt\n' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({
          stdout: args.includes('-z') ? '1\t0\tdocs/a => b.txt\0' : '1\t0\tdocs/a => b.txt\n'
        })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '1\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '-z',
        '--numstat',
        '-M',
        '-C',
        'merge-base-oid',
        'head-oid'
      ],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(result.entries).toEqual([
      { path: 'docs/a => b.txt', status: 'modified', added: 1, removed: 0 }
    ])
  })
})

describe('getCommitCompare', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
  })

  it('attaches counts for commit compare paths containing rename markers', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'commit-oid\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: 'commit-oid parent-oid\n' })
      }
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: 'M\tdocs/a => b.txt\n' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({
          stdout: args.includes('-z') ? '1\t0\tdocs/a => b.txt\0' : '1\t0\tdocs/a => b.txt\n'
        })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getCommitCompare('/repo', 'commit-oid')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '-z',
        '--numstat',
        '-M',
        '-C',
        'parent-oid',
        'commit-oid'
      ],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(result.entries).toEqual([
      { path: 'docs/a => b.txt', status: 'modified', added: 1, removed: 0 }
    ])
  })
})
