import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GitFetchHeadLockModule from '../../../shared/git/fetch/git-fetch-head-lock'

// Callback fixtures exercise native execFile; Mac spawn capture has real-child coverage.
const restorePlatform = vi.hoisted(() => {
  const platform = process.platform
  if (platform === 'darwin') {
    Object.defineProperty(process, 'platform', { value: 'linux' })
  }
  return () => Object.defineProperty(process, 'platform', { value: platform })
})
afterAll(restorePlatform)

const {
  execFileMock,
  spawnMock,
  killSpawnedCommandTreeMock,
  signalProcessTreeMock,
  forceTerminateProcessTreeMock
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  killSpawnedCommandTreeMock: vi.fn().mockResolvedValue(undefined),
  signalProcessTreeMock: vi.fn().mockResolvedValue(false),
  forceTerminateProcessTreeMock: vi.fn().mockResolvedValue(false)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
  spawn: spawnMock
}))
vi.mock('./process-capture/spawned-command-tree-kill', () => ({
  killSpawnedCommandTree: killSpawnedCommandTreeMock
}))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalProcessTreeMock,
  forceTerminateProcessTree: forceTerminateProcessTreeMock
}))
// Mock only filesystem key derivation so libuv completion order cannot reorder the real FIFO lock.
vi.mock('../../../shared/git/fetch/git-fetch-head-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof GitFetchHeadLockModule>()
  const { runWithGitOperationLock } =
    await import('../../../shared/git/commands/git-operation-lock')
  return {
    ...actual,
    runWithGitFetchHeadLock: <T>(
      worktreePath: string,
      signal: AbortSignal | undefined,
      run: () => Promise<T>
    ): Promise<T> => runWithGitOperationLock(worktreePath, signal, run)
  }
})

import { execFileCapture } from './process-capture/exec-file-capture'
import * as captureModule from './process-capture/exec-file-capture'
import { gitExecFileAsync } from './git-exec-file'
import { GitCommandTimeoutError } from '../../../shared/git/commands/git-command-timeout'

import { _resetGitAdmissionForTests } from './admission/git-subprocess-admission'
import { GitAdmissionScheduler } from '../../../shared/git/admission/git-admission-scheduler'

describe('git exec admission lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    execFileMock.mockReset()
    spawnMock.mockReset()
    killSpawnedCommandTreeMock.mockClear()
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    _resetGitAdmissionForTests()
  })

  it('reports pre-aborted capture as a no-child termination', async () => {
    const controller = new AbortController()
    const onChildTerminated = vi.fn()
    controller.abort()

    await expect(
      execFileCapture('git', ['status'], {
        signal: controller.signal,
        onChildTerminated
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(execFileMock).not.toHaveBeenCalled()
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('keeps a timed-out live checkout admitted until termination while reads proceed', async () => {
    vi.useRealTimers()
    const holders = Array.from({ length: 3 }, (_, index) => ({
      name: `holder-${index}`,
      started: Promise.withResolvers<void>(),
      capture: Promise.withResolvers<{ stdout: string; stderr: string }>(),
      terminate: () => {}
    }))
    let successorStarted = false
    vi.spyOn(captureModule, 'execFileCapture').mockImplementation((_binary, args, options) => {
      const holder = holders.find(({ name }) => args.includes(name))
      if (holder) {
        holder.terminate = () => options.onChildTerminated?.()
        holder.started.resolve()
        return holder.capture.promise
      }
      if (args.includes('successor')) {
        successorStarted = true
      }
      options.onChildTerminated?.()
      return Promise.resolve({ stdout: 'read completed', stderr: '' })
    })
    const checkoutOptions = {
      cwd: process.cwd(),
      admissionClass: 'checkout' as const,
      admissionTier: 'interactive' as const
    }
    const running = holders.map(({ name }) =>
      gitExecFileAsync(['worktree', 'add', name], checkoutOptions)
    )
    const timeout = expect(running[0]).rejects.toBeInstanceOf(GitCommandTimeoutError)
    await Promise.all(holders.map(({ started }) => started.promise))
    holders[0].capture.reject(new GitCommandTimeoutError(180_000))
    await timeout
    const successor = gitExecFileAsync(['worktree', 'add', 'successor'], checkoutOptions)
    try {
      await expect(
        gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: process.cwd() })
      ).resolves.toEqual({
        stdout: 'read completed',
        stderr: ''
      })
      expect(successorStarted).toBe(false)
      holders[0].terminate()
      await successor
      expect(successorStarted).toBe(true)
    } finally {
      holders.forEach((holder) => {
        holder.capture.resolve({ stdout: '', stderr: '' })
        holder.terminate()
      })
      await Promise.allSettled([...running, successor])
    }
  })
})
