import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

import { gitStreamStdout } from './runner'

function createChild(pid: number): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  pid: number
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
    pid: number
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  child.unref = vi.fn()
  child.pid = pid
  return child
}

describe('gitStreamStdout timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    spawnMock.mockReset()
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
  })

  it('rejects and kills the spawned git tree when the timeout elapses', async () => {
    vi.useFakeTimers()
    const gitChild = createChild(1234)
    const taskkillChild = createChild(9999)
    spawnMock.mockReturnValueOnce(gitChild).mockReturnValueOnce(taskkillChild)

    const resultPromise = gitStreamStdout(['status'], {
      cwd: 'C:\\repo',
      timeout: 25,
      onStdout: vi.fn()
    }).then(
      () => 'resolved',
      (error: unknown) => error
    )

    await vi.advanceTimersByTimeAsync(25)
    await Promise.resolve()

    const result = await Promise.race([resultPromise, Promise.resolve('pending')])

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('git timed out.')
    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenNthCalledWith(2, 'taskkill', ['/pid', '1234', '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      expect(taskkillChild.unref).toHaveBeenCalled()
    } else {
      expect(gitChild.kill).toHaveBeenCalled()
    }
  })
})
