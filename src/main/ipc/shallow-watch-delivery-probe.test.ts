import type * as NodeFs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return { ...actual, watch: watchMock }
})

import {
  detectShallowWatchDelivery,
  measureShallowWatchDelivery,
  resetShallowWatchDeliveryProbeForTests
} from './shallow-watch-delivery-probe'

function stubWatcher(onWatch?: (callback: () => void) => void) {
  return (_path: string, _options: unknown, callback: () => void) => {
    onWatch?.(callback)
    return { on: () => {}, close: () => {} }
  }
}

describe('shallow watch delivery probe', () => {
  it('reports delivery when the platform emits for the probe write', async () => {
    watchMock.mockImplementation(stubWatcher((callback) => setTimeout(callback, 0)))
    await expect(measureShallowWatchDelivery(1_000)).resolves.toBe(true)
  })

  it('reports no delivery when registration succeeds but nothing is emitted', async () => {
    // The observed macOS 26.3.1 failure: fs.watch returns a watcher, stays mute,
    // and never raises an error — indistinguishable from an idle repo.
    watchMock.mockImplementation(stubWatcher())
    await expect(measureShallowWatchDelivery(20)).resolves.toBe(false)
  })

  it('reports no delivery when the watcher raises instead of binding', async () => {
    watchMock.mockImplementation(() => {
      throw new Error('EMFILE')
    })
    await expect(measureShallowWatchDelivery(20)).resolves.toBe(false)
  })

  it('measures once per process', async () => {
    resetShallowWatchDeliveryProbeForTests()
    watchMock.mockImplementation(stubWatcher((callback) => setTimeout(callback, 0)))
    await detectShallowWatchDelivery()
    const calls = watchMock.mock.calls.length
    await detectShallowWatchDelivery()
    expect(watchMock.mock.calls.length).toBe(calls)
  })
})
