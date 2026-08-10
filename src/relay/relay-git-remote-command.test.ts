import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { runRelayGitRemoteCommand } from './relay-git-remote-command'

type MockChild = EventEmitter & {
  stdout: EventEmitter & { pause: ReturnType<typeof vi.fn> }
  stderr: EventEmitter & { pause: ReturnType<typeof vi.fn> }
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
  unref?: ReturnType<typeof vi.fn>
}

function mockChild(pid = 1234): MockChild {
  const child = new EventEmitter() as MockChild
  child.stdout = Object.assign(new EventEmitter(), { pause: vi.fn() })
  child.stderr = Object.assign(new EventEmitter(), { pause: vi.fn() })
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn(() => true)
  return child
}

async function withPlatform(platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('relay remote git command', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds a stalled POSIX command and terminates its process group', async () => {
    await withPlatform('linux', async () => {
      const child = mockChild()
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      spawnMock.mockReturnValue(child)
      try {
        const result = runRelayGitRemoteCommand(['push', 'origin', 'HEAD'], {
          cwd: '/repo',
          env: {},
          maxBuffer: 1024,
          timeout: 1000
        })
        const rejection = expect(result).rejects.toThrow('git timed out.')

        let settled = false
        void result
          .catch(() => {})
          .finally(() => {
            settled = true
          })
        await vi.advanceTimersByTimeAsync(1000)

        expect(spawnMock).toHaveBeenCalledWith(
          'git',
          ['push', 'origin', 'HEAD'],
          expect.objectContaining({ cwd: '/repo', detached: true })
        )
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGTERM')
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(2000)
        await rejection
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL')
      } finally {
        processKill.mockRestore()
      }
    })
  })

  it('keeps force-kill escalation armed after the process group leader closes', async () => {
    await withPlatform('linux', async () => {
      const child = mockChild()
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      spawnMock.mockReturnValue(child)
      try {
        const result = runRelayGitRemoteCommand(['fetch', '--prune'], {
          cwd: '/repo',
          env: {},
          maxBuffer: 1024,
          timeout: 1000
        })
        const rejection = expect(result).rejects.toThrow('git timed out.')

        await vi.advanceTimersByTimeAsync(1000)
        child.emit('close', null)
        await vi.advanceTimersByTimeAsync(2000)
        await rejection

        expect(processKill).toHaveBeenCalledTimes(2)
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL')
      } finally {
        processKill.mockRestore()
      }
    })
  })

  it('cancels a POSIX command tree once and disarms the operation timeout', async () => {
    await withPlatform('linux', async () => {
      const child = mockChild()
      const controller = new AbortController()
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      spawnMock.mockReturnValue(child)
      try {
        const result = runRelayGitRemoteCommand(['pull'], {
          cwd: '/repo',
          env: {},
          maxBuffer: 1024,
          signal: controller.signal,
          timeout: 1000
        })
        const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })

        controller.abort()
        await vi.advanceTimersByTimeAsync(1000)

        expect(processKill).toHaveBeenCalledTimes(1)
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGTERM')
        await vi.advanceTimersByTimeAsync(1000)
        await rejection
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL')
      } finally {
        processKill.mockRestore()
      }
    })
  })

  it('bounds output by bytes and terminates the POSIX command tree', async () => {
    await withPlatform('linux', async () => {
      const child = mockChild()
      const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      spawnMock.mockReturnValue(child)
      try {
        const result = runRelayGitRemoteCommand(['fetch'], {
          cwd: '/repo',
          env: {},
          maxBuffer: 4,
          timeout: 1000
        })
        const rejection = expect(result).rejects.toThrow('git stdout exceeded maxBuffer.')

        child.stdout.emit('data', Buffer.from('12345'))
        await vi.advanceTimersByTimeAsync(2000)
        await rejection

        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGTERM')
      } finally {
        processKill.mockRestore()
      }
    })
  })

  it('terminates the full Windows process tree on timeout', async () => {
    await withPlatform('win32', async () => {
      const command = mockChild()
      const taskkill = mockChild(9000)
      taskkill.unref = vi.fn()
      spawnMock.mockImplementation((executable: string) =>
        executable === 'taskkill' ? taskkill : command
      )

      const result = runRelayGitRemoteCommand(['push'], {
        cwd: 'C:\\repo',
        env: {},
        maxBuffer: 1024,
        timeout: 1000
      })
      const rejection = expect(result).rejects.toThrow('git timed out.')
      const observedError = result.catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(0)
      expect(command.stdout.listenerCount('data')).toBe(0)
      expect(command.stderr.listenerCount('data')).toBe(0)
      expect(command.stdout.pause).toHaveBeenCalledOnce()
      expect(command.stderr.pause).toHaveBeenCalledOnce()
      command.stdout.emit('data', Buffer.alloc(1024 * 1024))
      command.stderr.emit('data', Buffer.alloc(1024 * 1024))
      taskkill.emit('close', 0)
      await rejection
      await expect(observedError).resolves.toMatchObject({ stdout: '', stderr: '' })

      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ windowsHide: true })
      )
      expect(taskkill.unref).toHaveBeenCalled()
    })
  })

  it('refuses taskkill after the spawned Windows process identity is stale', async () => {
    await withPlatform('win32', async () => {
      const command = mockChild()
      command.exitCode = 0
      spawnMock.mockReturnValue(command)

      const result = runRelayGitRemoteCommand(['push'], {
        cwd: 'C:\\repo',
        env: {},
        maxBuffer: 1024,
        timeout: 1000
      })
      const rejection = expect(result).rejects.toThrow('git timed out.')

      await vi.advanceTimersByTimeAsync(1000)
      await rejection
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(command.kill).not.toHaveBeenCalledWith()
    })
  })

  it('refuses taskkill when the retained Windows process handle reports PID reuse', async () => {
    await withPlatform('win32', async () => {
      const command = mockChild()
      command.kill.mockImplementation((signal?: NodeJS.Signals | number) => signal !== 0)
      spawnMock.mockReturnValue(command)

      const result = runRelayGitRemoteCommand(['push'], {
        cwd: 'C:\\repo',
        env: {},
        maxBuffer: 1024,
        timeout: 1000
      })
      const rejection = expect(result).rejects.toThrow('git timed out.')

      await vi.advanceTimersByTimeAsync(1000)
      await rejection
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(command.kill).not.toHaveBeenCalledWith()
    })
  })

  it('falls back when Windows process-tree termination fails', async () => {
    await withPlatform('win32', async () => {
      const command = mockChild()
      const taskkills = [mockChild(9000), mockChild(9001)]
      taskkills.forEach((taskkill) => {
        taskkill.unref = vi.fn()
      })
      spawnMock.mockImplementation((executable: string) =>
        executable === 'taskkill' ? taskkills.shift() : command
      )

      const result = runRelayGitRemoteCommand(['push'], {
        cwd: 'C:\\repo',
        env: {},
        maxBuffer: 1024,
        timeout: 1000
      })
      const rejection = expect(result).rejects.toThrow('git timed out.')
      const observedError = result.catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(0)
      const firstTaskkill = spawnMock.mock.results[1]?.value as MockChild
      firstTaskkill.emit('close', 1)
      await vi.advanceTimersByTimeAsync(0)
      const secondTaskkill = spawnMock.mock.results[2]?.value as MockChild
      secondTaskkill.emit('close', 1)
      await rejection
      const error = await observedError

      expect(command.kill).toHaveBeenCalledWith()
      expect(error).toMatchObject({ cleanupError: expect.any(Error) })
    })
  })

  it('preserves split UTF-8 output', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const result = runRelayGitRemoteCommand(['fetch'], {
      cwd: '/repo',
      env: {},
      maxBuffer: 1024,
      timeout: 1000
    })
    const encoded = Buffer.from('café')
    child.stdout.emit('data', encoded.subarray(0, 4))
    child.stdout.emit('data', encoded.subarray(4))
    child.emit('close', 0)

    await expect(result).resolves.toEqual({ stdout: 'café', stderr: '' })
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })
})
