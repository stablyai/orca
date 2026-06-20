import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { runRelayGitRemoteCommand } from './relay-git-remote-command'

type MockChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
  unref?: ReturnType<typeof vi.fn>
}

function mockChild(pid = 1234): MockChild {
  const child = new EventEmitter() as MockChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = pid
  child.kill = vi.fn()
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

        await vi.advanceTimersByTimeAsync(1000)
        await rejection

        expect(spawnMock).toHaveBeenCalledWith(
          'git',
          ['push', 'origin', 'HEAD'],
          expect.objectContaining({ cwd: '/repo', detached: true })
        )
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGTERM')
        await vi.advanceTimersByTimeAsync(2000)
        expect(processKill).toHaveBeenCalledWith(-1234, 'SIGKILL')
      } finally {
        processKill.mockRestore()
      }
    })
  })

  it('cancels force-kill escalation after the process group closes', async () => {
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
        await rejection
        child.emit('close', null)
        await vi.advanceTimersByTimeAsync(2000)

        expect(processKill).toHaveBeenCalledTimes(1)
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

      await vi.advanceTimersByTimeAsync(1000)
      await rejection

      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ windowsHide: true })
      )
      expect(taskkill.unref).toHaveBeenCalled()
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
  })
})
