import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'

const { existsSyncMock, gitExecFileAsyncMock, readFileMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitStreamStdout: async (
    args: string[],
    options: { onStdout: (chunk: string) => boolean | void }
  ) => {
    const { stdout } = await gitExecFileAsyncMock(args)
    return { stoppedEarly: options.onStdout(stdout ?? '') === true }
  },
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  })
}))

vi.mock('fs/promises', () => ({ readFile: readFileMock }))
vi.mock('fs', () => ({ existsSync: existsSyncMock }))
vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof BoundedFileReader>()
  return {
    ...actual,
    readNodeFileWithinLimit: async (filePath: string, maxBytes: number) => {
      const value = await readFileMock(filePath)
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
      if (buffer.length > maxBytes) {
        throw new actual.NodeFileReadTooLargeError(buffer.length, maxBytes)
      }
      return { buffer, stats: { isFile: () => true, size: buffer.length } }
    }
  }
})

import {
  clearEffectiveUpstreamNegativeStatusCache,
  clearEffectiveUpstreamStatusCacheForTests,
  getEffectiveUpstreamStatusCacheCountForTests,
  getEffectiveUpstreamStatusGenerationCountForTests,
  getStatus,
  MAX_EFFECTIVE_UPSTREAM_CACHE_KEY_BYTES
} from './status'

describe('effective-upstream cache key bounds', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    existsSyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReturnValue(false)
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return { stdout: '# branch.oid abcdef1234567890\n# branch.head feature\n' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n' }
      }
      if (args[0] === 'config' && args[1] === '--list') {
        return { stdout: 'core.repositoryformatversion\n0\0' }
      }
      if (args[0] === 'rev-parse') {
        throw new Error('missing upstream')
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
  })

  it('re-probes without retaining keys above 64 KiB', async () => {
    const worktreePath = `/${'p'.repeat(MAX_EFFECTIVE_UPSTREAM_CACHE_KEY_BYTES)}`

    await getStatus(worktreePath)
    await getStatus(worktreePath)

    const upstreamProbes = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => (args as string[])[0] === 'rev-parse' && (args as string[]).includes('HEAD@{u}')
    )
    expect(upstreamProbes).toHaveLength(2)
    expect(getEffectiveUpstreamStatusCacheCountForTests()).toBe(0)
    expect(getEffectiveUpstreamStatusGenerationCountForTests()).toBe(0)

    clearEffectiveUpstreamNegativeStatusCache({ worktreePath, branchName: 'feature' })
    expect(getEffectiveUpstreamStatusGenerationCountForTests()).toBe(0)
  })
})
