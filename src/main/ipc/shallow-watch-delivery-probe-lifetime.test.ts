import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  watch: vi.fn(),
  mkdir: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  deliver: () => {},
  fail: () => {}
}))

vi.mock('node:fs', () => ({ watch: h.watch }))
vi.mock('node:fs/promises', () => ({
  mkdtemp: h.mkdir,
  writeFile: h.write,
  rm: h.remove
}))

import {
  detectShallowWatchDelivery,
  measureShallowWatchDelivery,
  resetShallowWatchDeliveryProbeForTests
} from './shallow-watch-delivery-probe'

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  resetShallowWatchDeliveryProbeForTests()
  h.deliver = () => {}
  h.fail = () => {}
  h.mkdir.mockResolvedValue('/fake-shallow-probe')
  h.write.mockResolvedValue(undefined)
  h.remove.mockResolvedValue(undefined)
  h.on.mockImplementation((_event: string, callback: () => void) => {
    h.fail = callback
  })
  h.watch.mockImplementation((_path: string, _options: unknown, callback: () => void) => {
    h.deliver = callback
    return { on: h.on, close: h.close }
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  resetShallowWatchDeliveryProbeForTests()
})

function expectReleased(): void {
  expect(h.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(h.remove).toHaveBeenCalledExactlyOnceWith('/fake-shallow-probe', {
    recursive: true,
    force: true
  })
}

describe('shallow probe resource ownership', () => {
  it.each([1, 2])('closes the watcher and clears the timer when write %i fails', async (write) => {
    if (write === 2) {
      h.write.mockResolvedValueOnce(undefined)
    }
    h.write.mockRejectedValueOnce(new Error('ENOSPC'))

    await expect(measureShallowWatchDelivery()).resolves.toBe(false)

    expect(h.write).toHaveBeenCalledTimes(write)
    expectReleased()
    expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.remove.mock.invocationCallOrder[0])
  })

  it('releases resources after successful delivery', async () => {
    h.write.mockImplementation(async () => h.deliver())

    await expect(measureShallowWatchDelivery()).resolves.toBe(true)

    expect(h.write).toHaveBeenCalledTimes(2)
    expectReleased()
  })

  it('releases resources after the delivery deadline', async () => {
    const result = measureShallowWatchDelivery(20)
    await vi.advanceTimersByTimeAsync(20)

    await expect(result).resolves.toBe(false)
    expectReleased()
  })

  it('releases resources when the watcher reports an error', async () => {
    h.write.mockImplementation(async () => h.fail())

    await expect(measureShallowWatchDelivery()).resolves.toBe(false)
    expectReleased()
  })

  it.each(['delivery', 'write failure'])(
    'preserves false fallback when close throws after %s',
    async (outcome) => {
      h.close.mockImplementation(() => {
        throw new Error('close failed')
      })
      if (outcome === 'delivery') {
        h.write.mockImplementation(async () => h.deliver())
      } else {
        h.write.mockRejectedValueOnce(new Error('write failed'))
      }

      await expect(measureShallowWatchDelivery()).resolves.toBe(false)
      expectReleased()
    }
  )

  it('removes the directory when watcher creation fails', async () => {
    h.watch.mockImplementation(() => {
      throw new Error('EMFILE')
    })

    await expect(measureShallowWatchDelivery()).resolves.toBe(false)

    expect(h.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(h.remove).toHaveBeenCalledOnce()
  })

  it('keeps successful delivery when temporary-directory removal fails', async () => {
    h.write.mockImplementation(async () => h.deliver())
    h.remove.mockRejectedValue(new Error('cleanup failed'))

    await expect(measureShallowWatchDelivery()).resolves.toBe(true)
    expectReleased()
  })

  it('caches a failed probe once per process after releasing its resources', async () => {
    h.write.mockRejectedValueOnce(new Error('write failed'))

    await expect(detectShallowWatchDelivery()).resolves.toBe(false)
    await expect(detectShallowWatchDelivery()).resolves.toBe(false)

    expect(h.watch).toHaveBeenCalledOnce()
    expect(h.write).toHaveBeenCalledOnce()
    expectReleased()
  })
})
