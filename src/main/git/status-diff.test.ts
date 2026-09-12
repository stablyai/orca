import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import path from 'node:path'
import {
  MAX_RENDERED_DIFF_COMBINED_CHARACTERS,
  MAX_RENDERED_DIFF_LINES_PER_SIDE
} from '../../shared/large-diff-render-limit'
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
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { getBranchDiff, getCommitDiff, getDiff, getStagedCommitContext, stageFile } from './status'

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
      maxBuffer: 10 * 1024 * 1024,
      preferWslDirectGit: true
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
      maxBuffer: 10 * 1024 * 1024,
      preferWslDirectGit: true
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
        maxBuffer: 10 * 1024 * 1024,
        preferWslDirectGit: true
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
    const workingTreePath = path.join('/repo', 'dist/large.log')
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: Buffer.from('index-content\n') })
    // Why by path: the diff also stats git-dir entries to stamp its inputs, so a
    // one-shot queue would hand the oversized size to whichever stat ran first.
    statMock.mockImplementation(async (target: string) =>
      target === workingTreePath
        ? { isFile: () => true, size: 10 * 1024 * 1024 + 1 }
        : { isFile: () => true, size: 12 }
    )

    const result = await getDiff('/repo', 'dist/large.log', false)

    expect(readFileMock).not.toHaveBeenCalledWith(workingTreePath)
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
    const workingTreePath = path.join('/repo', 'assets/deleted.png')
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: pngBuffer })
    statMock.mockImplementation(async (target: string) => {
      if (target === workingTreePath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return { isFile: () => true, size: 12 }
    })

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
    const workingTreePath = path.join('/repo', 'assets/unreadable.png')
    gitExecFileAsyncBufferMock.mockResolvedValueOnce({ stdout: pngBuffer })
    statMock.mockImplementation(async () => ({ isFile: () => true, size: 5 }))
    readFileMock.mockImplementation(async (target: string) => {
      if (target === workingTreePath) {
        throw new Error('EIO')
      }
      return Buffer.from('')
    })

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

    // Why both up front: the two sides are independent spawns issued concurrently,
    // so 8 identical reads still collapse to exactly 2 — one per side, not per read.
    await waitForMockCalls(gitExecFileAsyncBufferMock, 2)
    expect(gitExecFileAsyncBufferMock).toHaveBeenCalledTimes(2)

    leftBlob.resolve()
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
