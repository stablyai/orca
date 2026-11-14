import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild as createMockChildProcess } from '../../../shared/__fixtures__/fake-spawned-child'

// Callback fixtures exercise native execFile; Mac spawn capture has real-child coverage.
const restorePlatform = vi.hoisted(() => {
  const platform = process.platform
  if (platform === 'darwin') {
    Object.defineProperty(process, 'platform', { value: 'linux' })
  }
  return () => Object.defineProperty(process, 'platform', { value: platform })
})
afterAll(restorePlatform)

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))
import { commandExecFileAsync } from './process-capture/command-exec-file'
import { gitExecFileAsync } from './git-exec-file'
import { glabExecFileAsync } from './hosted-cli/glab-exec-file'
import { gitStreamStdout } from './git-stream-stdout'
import { _resetGitAdmissionForTests } from './admission/git-subprocess-admission'

afterEach(() => _resetGitAdmissionForTests())

describe('runner execFile timeout handling', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    execFileSyncMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects command executions when execFile never calls back after timeout', async () => {
    const child = createMockChildProcess(1234)
    execFileMock.mockReturnValue(child)

    const promise = commandExecFileAsync('git', ['status'], {
      cwd: '/repo',
      timeout: 1000
    })
    const rejection = expect(promise).rejects.toThrow(/git(?:\.exe)? timed out\./i)
    await vi.advanceTimersByTimeAsync(1000)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a barrier Git abort pending until the process group closes',
    async () => {
      const child = createMockChildProcess(1234)
      spawnMock.mockImplementation((command: string) => {
        if (command !== 'ps') {
          return child
        }
        const probe = createMockChildProcess(4321)
        queueMicrotask(() => probe.emit('close', 0, null))
        return probe
      })
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const controller = new AbortController()
      try {
        const pending = gitExecFileAsync(['status'], {
          cwd: '/repo',
          signal: controller.signal,
          terminationBarrier: true
        })
        let settled = false
        void pending.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          }
        )

        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
        controller.abort()
        child.emit('close', 0, null)
        await vi.advanceTimersByTimeAsync(1_999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL')

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        processKill.mockRestore()
      }
    }
  )

  // CLI shims have descendants; direct-child signals can leave them running beyond the deadline.

  it('aborts glab retry backoff instead of starting another attempt', async () => {
    const controller = new AbortController()
    const transient = Object.assign(new Error('glab failed'), {
      stderr: 'HTTP 503 Service Unavailable'
    })
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChildProcess(1234)
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from(transient.stderr))
        child.emit('exit', 1, null)
        child.emit('close', 1, null)
      })
      return child
    })

    const promise = glabExecFileAsync(['api', 'projects'], {
      cwd: '/repo',
      signal: controller.signal
    })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await rejection
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})

describe('gitStreamStdout', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('rejects (not crashes) when the onStdout callback throws', async () => {
    const child = createMockChildProcess(1234)
    spawnMock.mockReturnValue(child)

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      onStdout: () => {
        throw new Error('parser blew up')
      }
    })
    const rejection = expect(promise).rejects.toThrow('parser blew up')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    child.stdout.emit('data', Buffer.from('? a.txt\n'))

    await rejection
    expect(child.kill).toHaveBeenCalled()
    child.emit('close', null, 'SIGTERM')
  })

  it('handles a late spawn error after cancellation', async () => {
    const child = createMockChildProcess(0)
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()

    const promise = gitStreamStdout(['status'], {
      cwd: '/repo',
      signal: controller.signal,
      onStdout: () => {}
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow()
  })
})
