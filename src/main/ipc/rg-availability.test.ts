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
import { RipgrepLaunchFailureError } from '../../shared/ripgrep-process-availability'

function createMockProcess(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as unknown as { kill: () => boolean }).kill = vi.fn(() => true)
  return child
}

describe('checkRgAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('rejects transient synchronous launch pressure when requested', async () => {
    wslAwareSpawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn rg ENOMEM'), { code: 'ENOMEM' })
    })

    await expect(
      checkRgAvailable('/repo', 'Ubuntu', { rejectTransientLaunchFailure: true })
    ).rejects.toBeInstanceOf(RipgrepLaunchFailureError)
  })

  it('rejects transient asynchronous launch pressure when requested', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    const promise = checkRgAvailable('/repo', 'Ubuntu', {
      rejectTransientLaunchFailure: true
    })

    child.emit('error', Object.assign(new Error('spawn rg EAGAIN'), { code: 'EAGAIN' }))

    await expect(promise).rejects.toBeInstanceOf(RipgrepLaunchFailureError)
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
