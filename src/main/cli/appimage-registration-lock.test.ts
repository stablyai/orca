import { afterEach, describe, expect, it, vi } from 'vitest'

const { lockMock, mkdirMock } = vi.hoisted(() => ({ lockMock: vi.fn(), mkdirMock: vi.fn() }))

vi.mock('proper-lockfile', () => ({ lock: lockMock }))
vi.mock('node:fs/promises', () => ({ mkdir: mkdirMock }))

afterEach(() => {
  vi.resetModules()
})

async function load() {
  mkdirMock.mockReset().mockResolvedValue(undefined)
  return import('./appimage-registration-lock')
}

describe('withAppImageRegistrationLock', () => {
  it('bounds the wait with a wall-clock deadline, not just an attempt count', async () => {
    lockMock.mockReset().mockResolvedValue(vi.fn().mockResolvedValue(undefined))
    const { withAppImageRegistrationLock } = await load()

    await withAppImageRegistrationLock('/cache/orca/appimage', async () => 'done')

    const options = lockMock.mock.calls[0][1]
    // Why: `retries` alone caps attempts, not elapsed time — 1000 x 1s is ~16 minutes.
    expect(options.retries.maxRetryTime).toBeGreaterThan(0)
    expect(options.retries.maxRetryTime).toBeLessThanOrEqual(options.stale)
  })

  it('reports a wedged holder with a remedy instead of hanging', async () => {
    lockMock.mockReset().mockRejectedValue(Object.assign(new Error('ELOCKED'), { code: 'ELOCKED' }))
    const { withAppImageRegistrationLock } = await load()

    await expect(
      withAppImageRegistrationLock('/cache/orca/appimage', async () => 'done')
    ).rejects.toThrow(/Timed out waiting for another Orca process[\s\S]*remove .*\.lock/)
  })

  it('releases the lock when the operation throws', async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    lockMock.mockReset().mockResolvedValue(release)
    const { withAppImageRegistrationLock } = await load()

    await expect(
      withAppImageRegistrationLock('/cache/orca/appimage', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(release).toHaveBeenCalledTimes(1)
  })
})
