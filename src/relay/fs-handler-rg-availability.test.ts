import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  pid = 1234
  kill = vi.fn()
}

describe('relay rg availability', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
  })

  it('does not spawn when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(checkRgAvailable(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('removes listeners after a successful probe', async () => {
    const child = new FakeChildProcess()
    execFileMock.mockReturnValueOnce(child)

    const result = checkRgAvailable()
    child.emit('close', 0)

    await expect(result).resolves.toBe(true)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('returns false when rg is unavailable', async () => {
    const child = new FakeChildProcess()
    execFileMock.mockReturnValueOnce(child)

    const result = checkRgAvailable()
    child.emit('error', new Error('rg not found'))

    await expect(result).resolves.toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('aborts a pending probe without starting fallback', async () => {
    const child = new FakeChildProcess()
    const controller = new AbortController()
    const fallback = vi.fn()
    execFileMock.mockReturnValueOnce(child)

    const search = async (): Promise<void> => {
      if (!(await checkRgAvailable(controller.signal))) {
        fallback()
      }
    }
    const result = search()
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(fallback).not.toHaveBeenCalled()
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
