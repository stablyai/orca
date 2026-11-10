import type * as RunnerModule from '../runner'
import type * as GitExecFileModule from '../command-runner/git-exec-file'
import type * as GitStreamStdoutModule from '../command-runner/git-stream-stdout'
import type * as GitProcessEnvModule from '../command-runner/git-process-env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../../shared/file-content/node-bounded-file-reader'
import path from 'node:path'

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

vi.mock('../runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('../command-runner/git-exec-file', async (importOriginal) => {
  const runnerMocks = await vi.importMock<typeof RunnerModule>('../runner')
  return {
    ...(await importOriginal<typeof GitExecFileModule>()),
    gitExecFileAsync: runnerMocks.gitExecFileAsync,
    gitExecFileAsyncBuffer: runnerMocks.gitExecFileAsyncBuffer
  }
})

vi.mock('../command-runner/git-stream-stdout', async (importOriginal) => {
  const runnerMocks = await vi.importMock<typeof RunnerModule>('../runner')
  return {
    ...(await importOriginal<typeof GitStreamStdoutModule>()),
    gitStreamStdout: runnerMocks.gitStreamStdout
  }
})

vi.mock('../command-runner/git-process-env', async (importOriginal) => {
  const runnerMocks = await vi.importMock<typeof RunnerModule>('../runner')
  return {
    ...(await importOriginal<typeof GitProcessEnvModule>()),
    gitOptionalLocksDisabledEnv: runnerMocks.gitOptionalLocksDisabledEnv
  }
})

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../../shared/file-content/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)
import { getDiff } from './file-diff'
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
})
