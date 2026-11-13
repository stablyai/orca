import type * as GitExecFileModule from '../../command-runner/git-exec-file'
import type * as GitStreamStdoutModule from '../../command-runner/git-stream-stdout'
import type * as GitProcessEnvModule from '../../command-runner/git-environment/git-process-env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../../../shared/file-content/node-bounded-file-reader'
import path from 'node:path'
import {
  createBoundedFileReaderModuleMock,
  createFsPromisesModuleMock,
  createGitExecFileModuleMock,
  createGitStreamStdoutModuleMock,
  createGitProcessEnvModuleMock
} from '../diffs/status-test-harness'

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

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  ...createGitExecFileModuleMock({ gitExecFileAsyncMock, gitExecFileAsyncBufferMock })
}))

vi.mock('../../command-runner/git-stream-stdout', async (importOriginal) => ({
  ...(await importOriginal<typeof GitStreamStdoutModule>()),
  ...createGitStreamStdoutModuleMock({ gitExecFileAsyncMock, gitStreamOptionsMock })
}))

vi.mock('../../command-runner/git-environment/git-process-env', async (importOriginal) => ({
  ...(await importOriginal<typeof GitProcessEnvModule>()),
  ...createGitProcessEnvModuleMock()
}))

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../../../shared/file-content/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)
import { clearSubmodulePathsCacheForTests } from './submodule-paths'
import { getDiff } from '../diffs/file-diff'

describe('submodule diff routing', () => {
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
})
