import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock
}))

import { checkRgAvailable } from './fs-handler-utils'

class FakeChildProcess extends EventEmitter {
  kill = vi.fn()
}

describe('relay rg availability', () => {
  it('removes listeners after a successful probe', async () => {
    const child = new FakeChildProcess()
    execFileMock.mockReturnValueOnce(child)

    const result = checkRgAvailable()
    child.emit('close', 0)

    await expect(result).resolves.toBe(true)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('settles and detaches when a wedged probe ignores timeout kill', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChildProcess()
      execFileMock.mockReturnValueOnce(child)

      const result = checkRgAvailable()
      await vi.advanceTimersByTimeAsync(5000)

      await expect(result).resolves.toBe(false)
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
