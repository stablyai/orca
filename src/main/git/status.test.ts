/* eslint-disable max-lines -- Why: git status/discard/chunking behavior is verified together here to keep the command contract readable in one place. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import path from 'node:path'
import {
  MAX_RENDERED_DIFF_COMBINED_CHARACTERS,
  MAX_RENDERED_DIFF_LINES_PER_SIDE
} from '../../shared/large-diff-render-limit'

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
  clearSubmodulePathsCacheForTests,
  detectConflictOperation,
  getBranchDiff,
  discardChanges,
  getCommitDiff,
  getBranchCompare,
  getCommitCompare,
  getDiff,
  getStagedCommitContext,
  getStatus,
  getSubmoduleStatus,
  isWithinWorktree,
  listSubmodulePaths,
  resolveSubmoduleWorktreePath,
  stageFile
} from './status'

function deferredBuffer(content: string): {
  promise: Promise<{ stdout: Buffer }>
  resolve: () => void
} {
  let resolve!: (value: { stdout: Buffer }) => void
  const promise = new Promise<{ stdout: Buffer }>((innerResolve) => {
    resolve = innerResolve
  })
  return {
    promise,
    resolve: () => resolve({ stdout: Buffer.from(content) })
  }
}

async function waitForMockCalls(mock: ReturnType<typeof vi.fn>, calls: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (mock.mock.calls.length >= calls) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

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

  it('omits over-limit text bodies before returning the diff payload', async () => {
    const oversizedText = 'a'.repeat(MAX_RENDERED_DIFF_COMBINED_CHARACTERS + 1)
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from('index-content\n') })
    statMock.mockResolvedValueOnce({
      isFile: () => true,
      size: oversizedText.length
    })
    readFileMock.mockResolvedValue(Buffer.from(oversizedText))

    const result = await getDiff('/repo', 'dist/large.log', false)

    expect(result.kind).toBe('text')
    if (result.kind !== 'text') {
      throw new Error('expected text diff result')
    }
    expect(result.originalContent).toBe('')
    expect(result.modifiedContent).toBe('')
    expect(result.largeDiffRenderLimit?.limited).toBe(true)
    if (result.largeDiffRenderLimit?.limited !== true) {
      throw new Error('expected large diff render limit')
    }
    expect(result.largeDiffRenderLimit.reason).toBe('character-count')
    expect(result.largeDiffRenderLimit.characterCount).toBe(
      oversizedText.length + 'index-content\n'.length
    )
  })

  it('omits over-limit text bodies when line-count exceeds the cap', async () => {
    const oversizedByLines = 'x\n'.repeat(MAX_RENDERED_DIFF_LINES_PER_SIDE)
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from('index-content\n') })
    statMock.mockResolvedValueOnce({
      isFile: () => true,
      size: oversizedByLines.length
    })
    readFileMock.mockResolvedValue(Buffer.from(oversizedByLines))

    const result = await getDiff('/repo', 'dist/large-lines.log', false)

    expect(result.kind).toBe('text')
    if (result.kind !== 'text') {
      throw new Error('expected text diff result')
    }
    expect(result.originalContent).toBe('')
    expect(result.modifiedContent).toBe('')
    expect(result.largeDiffRenderLimit?.limited).toBe(true)
    if (result.largeDiffRenderLimit?.limited !== true) {
      throw new Error('expected large diff render limit')
    }
    expect(result.largeDiffRenderLimit.reason).toBe('line-count')
    expect(result.largeDiffRenderLimit.lineCounts?.modified).toBeGreaterThan(
      MAX_RENDERED_DIFF_LINES_PER_SIDE
    )
  })

  it('marks git blobs that overflow maxBuffer as binary instead of pretending they are missing', async () => {
    gitExecFileAsyncBufferMock.mockRejectedValueOnce(
      Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' })
    )
    readFileMock.mockResolvedValue(Buffer.from('working-tree-content'))

    const result = await getDiff('/repo', 'src/file.txt', false)

    expect(result.kind).toBe('binary')
    expect(result.originalIsBinary).toBe(true)
    expect(result.originalContent).toBe('')
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

  it('flags a deleted image so previewers can fall back to the original bytes', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: pngBuffer })
    statMock.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    const result = await getDiff('/repo', 'assets/deleted.png', false)

    expect(result.kind).toBe('binary')
    if (result.kind !== 'binary') {
      throw new Error('expected binary diff result')
    }
    expect(result.modifiedDeleted).toBe(true)
    expect(result.originalContent).toBe(pngBuffer.toString('base64'))
    expect(result.modifiedContent).toBe('')
  })

  it('does not treat an unreadable working-tree image as a deletion', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: pngBuffer })
    statMock.mockResolvedValueOnce({ isFile: () => true, size: 5 })
    readFileMock.mockRejectedValueOnce(new Error('EIO'))

    const result = await getDiff('/repo', 'assets/unreadable.png', false)

    expect(result.kind).toBe('binary')
    if (result.kind !== 'binary') {
      throw new Error('expected binary diff result')
    }
    expect(result.modifiedDeleted).toBeUndefined()
  })

  it('coalesces concurrent identical staged diff reads while in flight', async () => {
    const leftBlob = deferredBuffer('head-content\n')
    const rightBlob = deferredBuffer('index-content\n')
    const pendingBuffers = [leftBlob, rightBlob]
    gitExecFileAsyncBufferMock.mockImplementation(async () => pendingBuffers.shift()!.promise)

    const reads = Array.from({ length: 8 }, () => getDiff('/repo', 'src/file.ts', true))

    await waitForMockCalls(gitExecFileAsyncBufferMock, 1)
    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(1)

    leftBlob.resolve()
    await waitForMockCalls(gitExecFileAsyncBufferMock, 2)
    rightBlob.resolve()

    const results = await Promise.all(reads)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(2)
    expect(results.every((result) => result.kind === 'text')).toBe(true)

    gitExecFileAsyncBufferMock
      .mockResolvedValueOnce({ stdout: Buffer.from('fresh-head\n') })
      .mockResolvedValueOnce({ stdout: Buffer.from('fresh-index\n') })

    await getDiff('/repo', 'src/file.ts', true)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(4)
  })

  it('clears pending diff reads when a mutation runs', async () => {
    const firstBlob = deferredBuffer('head-content\n')
    const secondBlob = deferredBuffer('fresh-head-content\n')
    const pendingBuffers = [firstBlob, secondBlob]
    gitExecFileAsyncBufferMock.mockImplementation(async () => pendingBuffers.shift()!.promise)
    readFileMock.mockResolvedValue(Buffer.from('working-tree\n'))
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    const first = getDiff('/repo', 'src/file.ts', false)
    await waitForMockCalls(gitExecFileAsyncBufferMock, 1)

    await stageFile('/repo', 'src/file.ts')

    const second = getDiff('/repo', 'src/file.ts', false)
    await waitForMockCalls(gitExecFileAsyncBufferMock, 2)

    firstBlob.resolve()
    secondBlob.resolve()
    await Promise.all([first, second])

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['add', '--', ':(literal)src/file.ts'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('coalesces concurrent identical branch and commit diff reads while in flight', async () => {
    const branchLeftBlob = deferredBuffer('branch-left\n')
    const branchRightBlob = deferredBuffer('branch-right\n')
    const pendingBranchBuffers = [branchLeftBlob, branchRightBlob]
    gitExecFileAsyncBufferMock.mockImplementation(async () => pendingBranchBuffers.shift()!.promise)

    const branchReads = Array.from({ length: 8 }, () =>
      getBranchDiff('/repo', {
        mergeBase: 'b'.repeat(40),
        headOid: 'c'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      })
    )

    await waitForMockCalls(gitExecFileAsyncBufferMock, 1)
    branchLeftBlob.resolve()
    await waitForMockCalls(gitExecFileAsyncBufferMock, 2)
    branchRightBlob.resolve()

    await Promise.all(branchReads)
    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(2)

    gitExecFileAsyncBufferMock.mockReset()
    const commitLeftBlob = deferredBuffer('commit-left\n')
    const commitRightBlob = deferredBuffer('commit-right\n')
    const pendingCommitBuffers = [commitLeftBlob, commitRightBlob]
    gitExecFileAsyncBufferMock.mockImplementation(async () => pendingCommitBuffers.shift()!.promise)

    const commitReads = Array.from({ length: 8 }, () =>
      getCommitDiff('/repo', {
        parentOid: 'd'.repeat(40),
        commitOid: 'e'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      })
    )

    await waitForMockCalls(gitExecFileAsyncBufferMock, 1)
    commitLeftBlob.resolve()
    await waitForMockCalls(gitExecFileAsyncBufferMock, 2)
    commitRightBlob.resolve()

    await Promise.all(commitReads)
    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(2)
  })

  it('coalesces logically identical branch and commit diff args regardless of property order', async () => {
    gitExecFileAsyncBufferMock.mockResolvedValue({ stdout: Buffer.from('blob\n') })

    await Promise.all([
      getBranchDiff('/repo', {
        mergeBase: 'b'.repeat(40),
        headOid: 'c'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      getBranchDiff('/repo', {
        oldPath: 'src/old-file.ts',
        filePath: 'src/file.ts',
        headOid: 'c'.repeat(40),
        mergeBase: 'b'.repeat(40)
      })
    ])

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(2)

    gitExecFileAsyncBufferMock.mockClear()

    await Promise.all([
      getCommitDiff('/repo', {
        parentOid: 'd'.repeat(40),
        commitOid: 'e'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      getCommitDiff('/repo', {
        oldPath: 'src/old-file.ts',
        filePath: 'src/file.ts',
        commitOid: 'e'.repeat(40),
        parentOid: 'd'.repeat(40)
      })
    ])

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(2)
  })

  it('keeps distinct diff inputs on separate in-flight reads', async () => {
    gitExecFileAsyncBufferMock.mockResolvedValue({ stdout: Buffer.from('blob\n') })
    readFileMock.mockResolvedValue(Buffer.from('working-tree\n'))

    await Promise.all([
      getDiff('/repo', 'src/file.ts', false, false),
      getDiff('/repo', 'src/file.ts', false, true),
      getDiff('/repo', 'src/file.ts', true, false),
      getDiff('/repo', 'src/file.ts', true, false, { wslDistro: 'ubuntu' }),
      getDiff('/repo', 'src/file.ts', true, false, { wslDistro: 'debian' })
    ])

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(8)

    gitExecFileAsyncBufferMock.mockReset()
    gitExecFileAsyncBufferMock.mockResolvedValue({ stdout: Buffer.from('blob\n') })

    await Promise.all([
      getBranchDiff('/repo', {
        mergeBase: 'b'.repeat(40),
        headOid: 'c'.repeat(40),
        filePath: 'src/file.ts'
      }),
      getBranchDiff('/repo', {
        mergeBase: 'b'.repeat(40),
        headOid: 'd'.repeat(40),
        filePath: 'src/file.ts'
      }),
      getBranchDiff('/repo', {
        mergeBase: 'b'.repeat(40),
        headOid: 'c'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-a.ts'
      }),
      getBranchDiff('/repo', {
        mergeBase: 'b'.repeat(40),
        headOid: 'c'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-b.ts'
      }),
      getCommitDiff('/repo', {
        parentOid: 'e'.repeat(40),
        commitOid: 'f'.repeat(40),
        filePath: 'src/file.ts'
      }),
      getCommitDiff('/repo', {
        parentOid: 'a'.repeat(40),
        commitOid: 'f'.repeat(40),
        filePath: 'src/file.ts'
      }),
      getCommitDiff('/repo', {
        parentOid: 'e'.repeat(40),
        commitOid: 'f'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-a.ts'
      }),
      getCommitDiff('/repo', {
        parentOid: 'e'.repeat(40),
        commitOid: 'f'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-b.ts'
      })
    ])

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(16)
  })

  it('coalesces parentless root commit diff reads without reading a left-side blob', async () => {
    const rightBlob = deferredBuffer('root-content\n')
    gitExecFileAsyncBufferMock.mockImplementation(async () => rightBlob.promise)

    const reads = Array.from({ length: 8 }, () =>
      getCommitDiff('/repo', {
        parentOid: null,
        commitOid: 'e'.repeat(40),
        filePath: 'src/file.ts'
      })
    )

    await waitForMockCalls(gitExecFileAsyncBufferMock, 1)
    rightBlob.resolve()
    await Promise.all(reads)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(1)
  })
})

describe('submodule diff routing', () => {
  const OLD_OID = 'a'.repeat(40)
  const NEW_OID = 'b'.repeat(40)
  const PARENT = path.resolve('/repo-sm')
  const SUBMODULE = path.join(PARENT, 'flutter_mine')

  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    statMock.mockReset()
    existsSyncMock.mockReset()
    statMock.mockResolvedValue({ isFile: () => true, size: 12 })
    // Route git invocations by argv/cwd so the routing logic can resolve the
    // gitlink oids without touching a real repo.
    gitExecFileAsyncMock.mockImplementation((args: string[], options?: { cwd?: string }) => {
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        // Only the parent worktree declares the submodule; the recursion into the
        // submodule worktree must see no nested submodules.
        return Promise.resolve({
          stdout: options?.cwd === PARENT ? 'submodule.flutter_mine.path flutter_mine\n' : ''
        })
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stdout: `160000 ${OLD_OID} 0\tflutter_mine\n` })
      }
      if (args[0] === 'ls-tree') {
        return Promise.resolve({ stdout: `160000 commit ${OLD_OID}\tflutter_mine\n` })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${NEW_OID}\n` })
      }
      return Promise.resolve({ stdout: '' })
    })
  })

  it('synthesizes a Subproject commit pointer diff for the gitlink root', async () => {
    const result = await getDiff(PARENT, 'flutter_mine', false)

    expect(result.kind).toBe('text')
    expect(result.originalContent).toBe(`Subproject commit ${OLD_OID}\n`)
    expect(result.modifiedContent).toBe(`Subproject commit ${NEW_OID}\n`)
  })

  it('diffs inner files across the two commits when the gitlink moved', async () => {
    gitExecFileAsyncBufferMock.mockImplementation((args: string[]) => {
      const spec = String(args.at(-1))
      if (spec.startsWith(`${OLD_OID}:`)) {
        return Promise.resolve({ stdout: Buffer.from('v1\n') })
      }
      if (spec.startsWith(`${NEW_OID}:`)) {
        return Promise.resolve({ stdout: Buffer.from('v2\n') })
      }
      return Promise.resolve({ stdout: Buffer.from('') })
    })

    const result = await getDiff(PARENT, 'flutter_mine/lib/main.dart', false)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledWith(
      ['show', '--end-of-options', `${OLD_OID}:lib/main.dart`],
      { cwd: SUBMODULE, maxBuffer: 10 * 1024 * 1024 }
    )
    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledWith(
      ['show', '--end-of-options', `${NEW_OID}:lib/main.dart`],
      { cwd: SUBMODULE, maxBuffer: 10 * 1024 * 1024 }
    )
    expect(result.kind).toBe('text')
    expect(result.originalContent).toBe('v1\n')
    expect(result.modifiedContent).toBe('v2\n')
  })

  it('diffs staged inner files from parent HEAD to parent index', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[], options?: { cwd?: string }) => {
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return Promise.resolve({
          stdout: options?.cwd === PARENT ? 'submodule.flutter_mine.path flutter_mine\n' : ''
        })
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stdout: `160000 ${NEW_OID} 0\tflutter_mine\n` })
      }
      if (args[0] === 'ls-tree') {
        return Promise.resolve({ stdout: `160000 commit ${OLD_OID}\tflutter_mine\n` })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${NEW_OID}\n` })
      }
      return Promise.resolve({ stdout: '' })
    })
    gitExecFileAsyncBufferMock.mockImplementation((args: string[]) => {
      const spec = String(args.at(-1))
      if (spec.startsWith(`${OLD_OID}:`)) {
        return Promise.resolve({ stdout: Buffer.from('v1\n') })
      }
      if (spec.startsWith(`${NEW_OID}:`)) {
        return Promise.resolve({ stdout: Buffer.from('v2\n') })
      }
      return Promise.resolve({ stdout: Buffer.from('') })
    })

    const result = await getDiff(PARENT, 'flutter_mine/lib/main.dart', true)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledWith(
      ['show', '--end-of-options', `${OLD_OID}:lib/main.dart`],
      { cwd: SUBMODULE, maxBuffer: 10 * 1024 * 1024 }
    )
    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledWith(
      ['show', '--end-of-options', `${NEW_OID}:lib/main.dart`],
      { cwd: SUBMODULE, maxBuffer: 10 * 1024 * 1024 }
    )
    expect(result.kind).toBe('text')
    expect(result.originalContent).toBe('v1\n')
    expect(result.modifiedContent).toBe('v2\n')
  })

  it('reads inner files from the working tree when the commit is unchanged', async () => {
    // Override the gitlink oids so recorded == checked-out (no pointer move),
    // routing the inner diff back to the index/working-tree blob read.
    gitExecFileAsyncMock.mockImplementation((args: string[], options?: { cwd?: string }) => {
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return Promise.resolve({
          stdout: options?.cwd === PARENT ? 'submodule.flutter_mine.path flutter_mine\n' : ''
        })
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stdout: `160000 ${OLD_OID} 0\tflutter_mine\n` })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${OLD_OID}\n` })
      }
      return Promise.resolve({ stdout: '' })
    })
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from('old\n') })
    readFileMock.mockResolvedValue(Buffer.from('new'))

    const result = await getDiff(PARENT, 'flutter_mine/lib/main.dart', false)

    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledWith(['show', ':lib/main.dart'], {
      cwd: SUBMODULE,
      maxBuffer: 10 * 1024 * 1024
    })
    expect(readFileMock).toHaveBeenCalledWith(path.join(SUBMODULE, 'lib/main.dart'))
    expect(result.kind).toBe('text')
    expect(result.originalContent).toBe('old\n')
    expect(result.modifiedContent).toBe('new')
  })

  it('rejects inner submodule diffs whose .gitmodules path escapes the worktree', async () => {
    // A crafted .gitmodules path must not let the inner diff read escape the
    // selected worktree; loadDiff routes through resolveSubmoduleWorktreePath.
    gitExecFileAsyncMock.mockImplementation((args: string[], options?: { cwd?: string }) => {
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return Promise.resolve({
          stdout: options?.cwd === PARENT ? 'submodule.evil.path ../evil\n' : ''
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    await expect(getDiff(PARENT, '../evil/secret.txt', false)).rejects.toThrow('Access denied')
  })

  it('rejects gitlink pointer diffs whose .gitmodules path escapes the worktree', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[], options?: { cwd?: string }) => {
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return Promise.resolve({
          stdout: options?.cwd === PARENT ? 'submodule.evil.path ../evil\n' : ''
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    await expect(getDiff(PARENT, '../evil', false)).rejects.toThrow('Access denied')
  })
})

describe('resolveSubmoduleWorktreePath', () => {
  it('resolves a relative submodule path inside the worktree', () => {
    expect(resolveSubmoduleWorktreePath('/repo', 'flutter_mine')).toBe(
      path.resolve('/repo', 'flutter_mine')
    )
  })

  it('rejects absolute and escaping submodule paths', () => {
    expect(() => resolveSubmoduleWorktreePath('/repo', path.resolve('/etc'))).toThrow(
      'Access denied'
    )
    expect(() => resolveSubmoduleWorktreePath('/repo', '../outside')).toThrow('Access denied')
  })
})

describe('listSubmodulePaths', () => {
  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
    gitExecFileAsyncMock.mockReset()
  })

  it('keeps cached .gitmodules paths separate per WSL distro', async () => {
    gitExecFileAsyncMock.mockImplementation((_args: string[], options?: { wslDistro?: string }) =>
      Promise.resolve({
        stdout:
          options?.wslDistro === 'debian'
            ? 'submodule.lib.path debian-lib\n'
            : 'submodule.lib.path ubuntu-lib\n'
      })
    )

    await expect(listSubmodulePaths('/repo', { wslDistro: 'ubuntu' })).resolves.toEqual([
      'ubuntu-lib'
    ])
    await expect(listSubmodulePaths('/repo', { wslDistro: 'debian' })).resolves.toEqual([
      'debian-lib'
    ])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})

describe('getSubmoduleStatus', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
  })

  it('runs status inside the submodule worktree and returns inner entries', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/flutter_mine/.git\n')
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        '1 .M N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a ce013625030ba8dba906f756967f9e9ca394464a lib/main.dart\n'
    })

    const result = await getSubmoduleStatus('/repo', 'flutter_mine')

    expect(result.entries).toContainEqual({
      path: 'lib/main.dart',
      status: 'modified',
      area: 'unstaged'
    })
  })

  it('includes commit-range entries when the submodule pointer moved', async () => {
    const OLD_OID = 'a'.repeat(40)
    const NEW_OID = 'b'.repeat(40)
    readFileMock.mockResolvedValue('gitdir: /repo/flutter_mine/.git\n')
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      // Clean worktree: the inner status stream returns nothing.
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: 'M\tlib/main.dart\n' })
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stdout: `160000 ${OLD_OID} 0\tflutter_mine\n` })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${NEW_OID}\n` })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await getSubmoduleStatus('/repo', 'flutter_mine')

    expect(result.entries).toContainEqual(
      expect.objectContaining({ path: 'lib/main.dart', status: 'modified', area: 'unstaged' })
    )
  })

  it('includes staged commit-range entries from parent HEAD to parent index', async () => {
    const OLD_OID = 'a'.repeat(40)
    const NEW_OID = 'b'.repeat(40)
    readFileMock.mockResolvedValue('gitdir: /repo/flutter_mine/.git\n')
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      // Clean submodule worktree: the staged parent gitlink still has files to show.
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: 'M\tlib/main.dart\n' })
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stdout: `160000 ${NEW_OID} 0\tflutter_mine\n` })
      }
      if (args[0] === 'ls-tree') {
        return Promise.resolve({ stdout: `160000 commit ${OLD_OID}\tflutter_mine\n` })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${NEW_OID}\n` })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await getSubmoduleStatus('/repo', 'flutter_mine', { staged: true })

    expect(result.entries).toContainEqual(
      expect.objectContaining({ path: 'lib/main.dart', status: 'modified', area: 'unstaged' })
    )
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args.includes('status'))).toBe(false)
  })

  it('caps staged commit-range entries before returning them to the renderer', async () => {
    const OLD_OID = 'a'.repeat(40)
    const NEW_OID = 'b'.repeat(40)
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: 'M\tlib/a.dart\nM\tlib/b.dart\n' })
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stdout: `160000 ${NEW_OID} 0\tflutter_mine\n` })
      }
      if (args[0] === 'ls-tree') {
        return Promise.resolve({ stdout: `160000 commit ${OLD_OID}\tflutter_mine\n` })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await getSubmoduleStatus('/repo', 'flutter_mine', {
      staged: true,
      limit: 1
    })

    expect(result.entries).toHaveLength(1)
    expect(result.didHitLimit).toBe(true)
    expect(result.statusLength).toBe(2)
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

  it('benchmarks concurrent status burst subprocess pressure', async () => {
    const benchPath = process.env.ORCA_GIT_STATUS_COALESCING_BENCH_JSON
    if (!benchPath) {
      return
    }

    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        return Promise.resolve({ stdout: '' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const startedAt = performance.now()
    await Promise.all(Array.from({ length: 10 }, () => getStatus('/repo')))
    const durationMs = performance.now() - startedAt
    const statusCommandCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('status')
    ).length
    const { mkdirSync, writeFileSync } = await vi.importActual<typeof NodeFs>('fs')
    mkdirSync(path.dirname(benchPath), { recursive: true })
    writeFileSync(
      benchPath,
      JSON.stringify({
        scenario: 'git-status-concurrent-burst',
        concurrentCalls: 10,
        statusCommandCalls,
        durationMs
      })
    )
  })

  it('coalesces identical in-flight status reads without caching after settle', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    const releaseStatusReads: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatusReads.push(() => resolve({ stdout: '' }))
        })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const sharedRead = Promise.all([getStatus('/repo'), getStatus('/repo'), getStatus('/repo')])
    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    releaseStatusReads.splice(0).forEach((release) => release())
    await sharedRead
    expect(statusCommandCalls).toBe(1)

    const settledRead = getStatus('/repo')
    await vi.waitFor(() => expect(statusCommandCalls).toBe(2))
    releaseStatusReads.splice(0).forEach((release) => release())
    await settledRead
    expect(statusCommandCalls).toBe(2)
  })

  it('clears in-flight status reads when a mutation runs', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    const releaseStatusReads: (() => void)[] = []
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatusReads.push(() => resolve({ stdout: '' }))
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    const first = getStatus('/repo')
    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))

    // A mutation must invalidate the in-flight status read so the next getStatus
    // starts fresh instead of joining a pre-mutation promise and going stale.
    await stageFile('/repo', 'src/file.ts')

    const second = getStatus('/repo')
    await vi.waitFor(() => expect(statusCommandCalls).toBe(2))

    releaseStatusReads.splice(0).forEach((release) => release())
    await Promise.all([first, second])
    expect(statusCommandCalls).toBe(2)
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
      { cwd: '/repo' }
    )
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

  it('reuses unchanged line stats only when the safety hint is present', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
    existsSyncMock.mockReturnValue(false)
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
