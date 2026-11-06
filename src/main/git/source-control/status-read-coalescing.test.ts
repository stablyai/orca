import type * as RunnerModule from '../runner'
import type * as GitExecFileModule from '../command-runner/git-exec-file'
import type * as GitStreamStdoutModule from '../command-runner/git-stream-stdout'
import type * as GitProcessEnvModule from '../command-runner/git-process-env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../../shared/node-bounded-file-reader'
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

import { clearEffectiveUpstreamStatusCacheForTests } from './effective-upstream-status-cache'
import { getStatus } from './status-read'

describe('getStatus', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    gitStreamOptionsMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    existsSyncMock.mockReset()
    // Supply empty numstat results after tests' one-shot status responses.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
  })

  it('shares one physical status read across distinct caller signals', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let releaseStatus!: () => void
    let statusCommandCalls = 0
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.includes('status')) {
        statusCommandCalls += 1
        return new Promise<{ stdout: string }>((resolve) => {
          releaseStatus = () => resolve({ stdout: '' })
        })
      }
      return Promise.resolve({ stdout: '' })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstError = new Error('first caller cancelled')
    const first = getStatus('/repo', { signal: firstController.signal })
    const second = getStatus('/repo', { signal: secondController.signal })

    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    const underlyingSignal = gitStreamOptionsMock.mock.calls[0]?.[0].signal as AbortSignal
    firstController.abort(firstError)
    await expect(first).rejects.toBe(firstError)
    expect(underlyingSignal?.aborted).toBe(false)

    releaseStatus()
    await expect(second).resolves.toMatchObject({ entries: [] })
    expect(statusCommandCalls).toBe(1)
  })

  it('aborts physical status work after its last live caller cancels', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockReturnValue(false)
    let statusCommandCalls = 0
    let rejectStatus!: (error: unknown) => void
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (!args.includes('status')) {
        return Promise.resolve({ stdout: '' })
      }
      statusCommandCalls += 1
      if (statusCommandCalls > 1) {
        return Promise.resolve({ stdout: '' })
      }
      return new Promise<{ stdout: string }>((_resolve, reject) => {
        rejectStatus = reject
      })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = getStatus('/repo', { signal: firstController.signal })
    const second = getStatus('/repo', { signal: secondController.signal })

    await vi.waitFor(() => expect(statusCommandCalls).toBe(1))
    const underlyingSignal = gitStreamOptionsMock.mock.calls[0]?.[0].signal as AbortSignal
    underlyingSignal.addEventListener('abort', () => rejectStatus(underlyingSignal.reason), {
      once: true
    })
    firstController.abort(new Error('first cancelled'))
    await expect(first).rejects.toThrow('first cancelled')
    expect(underlyingSignal.aborted).toBe(false)
    secondController.abort(new Error('second cancelled'))
    await expect(second).rejects.toThrow('second cancelled')
    expect(underlyingSignal.aborted).toBe(true)

    await expect(getStatus('/repo')).resolves.toMatchObject({ entries: [] })
    expect(statusCommandCalls).toBe(2)
  })
})
