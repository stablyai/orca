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
import { clearSubmodulePathsCacheForTests } from './submodule-paths'
import { getDiff } from './file-diff'

describe('submodule diff routing', () => {
  const OLD_OID = 'a'.repeat(40)
  const NEW_OID = 'b'.repeat(40)
  const PARENT = path.resolve('/repo-sm')

  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    statMock.mockReset()
    existsSyncMock.mockReset()
    statMock.mockResolvedValue({ isFile: () => true, size: 12 })
    gitExecFileAsyncMock.mockImplementation((args: string[], options?: { cwd?: string }) => {
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        // Declare the submodule only in its parent so recursion terminates.
        return Promise.resolve({
          stdout: options?.cwd === PARENT ? 'submodule.flutter_mine.path\nflutter_mine\0' : ''
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

  it('rejects inner submodule diffs whose .gitmodules path escapes the worktree', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[], options?: { cwd?: string }) => {
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return Promise.resolve({
          stdout: options?.cwd === PARENT ? 'submodule.evil.path\n../evil\0' : ''
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
          stdout: options?.cwd === PARENT ? 'submodule.evil.path\n../evil\0' : ''
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    await expect(getDiff(PARENT, '../evil', false)).rejects.toThrow('Access denied')
  })
})
