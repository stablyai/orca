import { join } from 'node:path'
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
  noteShallowWatchDelivered,
  resetShallowWatchDeliveryProbeForTests
} from './shallow-watch-delivery-probe'

const originalPlatform = process.platform

beforeEach(() => {
  // Write counts below are for the directory probe; darwin is covered separately.
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
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
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
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

  it('re-measures a failed probe after the recheck delay instead of caching it', async () => {
    h.write.mockRejectedValueOnce(new Error('write failed'))

    await expect(detectShallowWatchDelivery()).resolves.toBe(false)
    await expect(detectShallowWatchDelivery()).resolves.toBe(false)
    expect(h.watch).toHaveBeenCalledOnce()
    expectReleased()

    h.write.mockImplementation(async () => h.deliver())
    vi.advanceTimersByTime(30_000)
    await expect(detectShallowWatchDelivery()).resolves.toBe(true)
    expect(h.watch).toHaveBeenCalledTimes(2)
  })

  it('trusts delivery observed elsewhere in the process without measuring', async () => {
    h.write.mockRejectedValueOnce(new Error('write failed'))
    await expect(detectShallowWatchDelivery()).resolves.toBe(false)

    noteShallowWatchDelivered()

    await expect(detectShallowWatchDelivery()).resolves.toBe(true)
    expect(h.watch).toHaveBeenCalledOnce()
  })

  it('probes a file watch on macOS, where shallow subscriptions watch files', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    h.write.mockImplementation(async () => {
      if (h.watch.mock.calls.length > 0) {
        h.deliver()
      }
    })

    await expect(measureShallowWatchDelivery()).resolves.toBe(true)

    const probePath = join('/fake-shallow-probe', 'probe')
    expect(h.write.mock.calls[0]).toEqual([probePath, '0'])
    expect(h.write.mock.invocationCallOrder[0]).toBeLessThan(h.watch.mock.invocationCallOrder[0])
    expect(h.watch.mock.calls[0][0]).toBe(probePath)
    expectReleased()
  })
})
