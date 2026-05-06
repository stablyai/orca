/* eslint-disable max-lines -- Why: git status/discard/chunking behavior is verified together here to keep the command contract readable in one place. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

const { gitExecFileAsyncMock, gitExecFileAsyncBufferMock, readFileMock, rmMock, existsSyncMock } =
  vi.hoisted(() => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncBufferMock: vi.fn(),
    readFileMock: vi.fn(),
    rmMock: vi.fn(),
    existsSyncMock: vi.fn()
  }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: gitExecFileAsyncBufferMock
}))

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  rm: rmMock
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

import {
  bulkStageFiles,
  bulkUnstageFiles,
  detectConflictOperation,
  discardChanges,
  getBranchCompare,
  getDiff,
  getStatus,
  isWithinWorktree
} from './status'

describe('discardChanges', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
  })

  it('restores tracked files from HEAD', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'src/file.ts\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await discardChanges('/repo', 'src/file.ts')

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['ls-files', '--error-unmatch', '--', 'src/file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['restore', '--worktree', '--source=HEAD', '--', 'src/file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('removes untracked files from disk', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not tracked'))

    await discardChanges('/repo', 'src/new-file.ts')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    // Why: discardChanges uses path.resolve(worktreePath, filePath) to build
    // the absolute rm target, which on Windows prepends a drive letter.
    expect(rmMock).toHaveBeenCalledWith(path.resolve('/repo', 'src', 'new-file.ts'), {
      force: true,
      recursive: true
    })
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
  })

  it('chunks bulk stage requests to avoid oversized argv payloads', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    const filePaths = Array.from({ length: 201 }, (_, i) => `src/file-${i}.ts`)
    await bulkStageFiles('/repo', filePaths)

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['add', '--', ...filePaths.slice(0, 100)],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['add', '--', ...filePaths.slice(200)],
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
      ['restore', '--staged', '--', ...filePaths.slice(100)],
      {
        cwd: '/repo'
      }
    )
  })
})

describe('getDiff', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReset()
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

  it('falls back to HEAD for unstaged diffs when the file is not in the index', async () => {
    gitExecFileAsyncBufferMock
      .mockRejectedValueOnce(new Error('missing index'))
      .mockResolvedValueOnce({ stdout: Buffer.from('head-content\n') })
    readFileMock.mockResolvedValue(Buffer.from('working-tree-content'))

    const result = await getDiff('/repo', 'src/file.ts', false)

    expect(gitExecFileAsyncBufferMock).toHaveBeenNthCalledWith(2, ['show', 'HEAD:src/file.ts'], {
      cwd: '/repo',
      maxBuffer: 10 * 1024 * 1024
    })
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
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReset()
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
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--untracked-files=all'],
      { cwd: '/repo' }
    )
    expect(result.entries).toEqual([
      { path: 'docs/日本語/sample.md', status: 'modified', area: 'unstaged' }
    ])
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
      .mockResolvedValueOnce({ stdout: 'head-oid\n' })
      .mockResolvedValueOnce({ stdout: 'base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({
        stdout: 'M\tfile-a.ts\nR100\told-name.ts\tnew-name.ts\nC100\told-copy.ts\tnew-copy.ts\n'
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
      { path: 'file-a.ts', status: 'modified' },
      { path: 'new-name.ts', oldPath: 'old-name.ts', status: 'renamed' },
      { path: 'new-copy.ts', oldPath: 'old-copy.ts', status: 'copied' }
    ])
  })

  it('returns invalid-base when the compare ref does not resolve', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
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
      .mockRejectedValueOnce(new Error('unborn'))

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary.status).toBe('unborn-head')
    expect(result.summary.errorMessage).toContain('committed HEAD')
    expect(result.entries).toEqual([])
  })

  it('returns no-merge-base when histories do not intersect', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
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
      .mockResolvedValueOnce({ stdout: 'head-oid\n' })
      .mockResolvedValueOnce({ stdout: 'base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'M\tdocs/日本語/sample.md\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      5,
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
    expect(result.entries).toEqual([{ path: 'docs/日本語/sample.md', status: 'modified' }])
  })
})
