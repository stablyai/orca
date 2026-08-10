import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { wslAwareSpawnMock } = vi.hoisted(() => ({
  wslAwareSpawnMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  wslAwareSpawn: wslAwareSpawnMock
}))

import { checkRgAvailable } from './rg-availability'

function createMockProcess(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as unknown as { pid: number }).pid = 1234
  ;(child as unknown as { kill: () => boolean }).kill = vi.fn(() => true)
  return child
}

describe('checkRgAvailable', () => {
  beforeEach(() => {
    wslAwareSpawnMock.mockReset()
  })

  it('does not spawn when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(checkRgAvailable('/repo', undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it('returns true when rg exits successfully', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)

    const promise = checkRgAvailable('/repo')
    child.emit('close', 0)

    await expect(promise).resolves.toBe(true)
    expect(wslAwareSpawnMock).toHaveBeenCalledWith('rg', ['--version'], {
      cwd: '/repo',
      stdio: 'ignore'
    })
  })

  it('returns false when rg is unavailable', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)

    const promise = checkRgAvailable('/repo')
    child.emit('error', new Error('rg not found'))

    await expect(promise).resolves.toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('aborts a pending probe without starting fallback', async () => {
    const child = createMockProcess()
    const controller = new AbortController()
    const fallback = vi.fn()
    wslAwareSpawnMock.mockReturnValue(child)

    const search = async (): Promise<void> => {
      if (!(await checkRgAvailable('/repo', undefined, controller.signal))) {
        fallback()
      }
    }
    const promise = search()
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('settles and detaches when rg availability check ignores timeout kills', async () => {
    vi.useFakeTimers()

    try {
      const child = createMockProcess()
      wslAwareSpawnMock.mockReturnValue(child)

      const promise = checkRgAvailable('/repo')
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(5000)

      await expect(Promise.race([promise, Promise.resolve('pending')])).resolves.toBe(false)
      expect(child.kill).toHaveBeenCalled()
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
