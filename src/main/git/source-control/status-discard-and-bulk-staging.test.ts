import type * as RunnerModule from '../runner'
import type * as GitExecFileModule from '../command-runner/git-exec-file'
import type * as GitStreamStdoutModule from '../command-runner/git-stream-stdout'
import type * as GitProcessEnvModule from '../command-runner/git-process-env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../../shared/node-bounded-file-reader'
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

vi.mock('../../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { bulkDiscardChanges, discardChanges } from './discard-changes'
import { bulkStageFiles, bulkUnstageFiles } from './staging'

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

  it('rejects paths that traverse outside the worktree', async () => {
    await expect(discardChanges('/repo', '../../etc/passwd')).rejects.toThrow(
      'resolves outside the worktree'
    )

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
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

  it('preserves bulk discard action selection and original path order for path edges', async () => {
    const filePaths = ['new', 'docs\\', '[ab].txt', 'docs///', 'new', 'src/file', 'docs\\']
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'docs/readme\0src/file-extra\0[ab].txt\0' })
      .mockResolvedValue({ stdout: '' })

    await bulkDiscardChanges('/repo', filePaths)

    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['ls-files', '-z', '--', ...filePaths.map((filePath) => `:(literal)${filePath}`)],
      ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
      ['clean', '-ffdx', '--', ':(literal)new', ':(literal)new', ':(literal)src/file']
    ])
    expect(gitExecFileAsyncMock.mock.calls[1][1].stdin).toBe(
      ':(literal)docs\\\0:(literal)[ab].txt\0:(literal)docs///\0:(literal)docs\\\0'
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

  it('rejects embedded NUL before staging or unstaging another path', async () => {
    await expect(bulkStageFiles('/repo', ['one\0two'])).rejects.toThrow('NUL')
    await expect(bulkUnstageFiles('/repo', ['one\0two'])).rejects.toThrow('NUL')

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
