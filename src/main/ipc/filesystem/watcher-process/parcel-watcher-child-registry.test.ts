import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PHYSICAL_WATCHER_CHILDREN,
  onWatcherChildCapacityAvailable,
  reserveWatcherChild,
  resetWatcherChildRegistryForTest
} from './parcel-watcher-child-registry'

function fillWatcherChildCapacity(): (() => void)[] {
  return Array.from({ length: MAX_PHYSICAL_WATCHER_CHILDREN }, () => {
    const release = reserveWatcherChild()
    if (!release) {
      throw new Error('expected watcher child reservation')
    }
    return release
  })
}

describe('parcel watcher child registry capacity notifications', () => {
  afterEach(() => resetWatcherChildRegistryForTest())

  it('notifies after capacity was released before listener registration', async () => {
    const releases = fillWatcherChildCapacity()
    expect(reserveWatcherChild()).toBeNull()
    releases.pop()?.()
    const listener = vi.fn()

    onWatcherChildCapacityAvailable(listener)
    await Promise.resolve()

    expect(listener).toHaveBeenCalledOnce()
    releases.forEach((release) => release())
  })

  it('cancels a pending capacity notification without leaking the listener', () => {
    const releases = fillWatcherChildCapacity()
    const listener = vi.fn()
    const cancel = onWatcherChildCapacityAvailable(listener)

    cancel()
    releases.pop()?.()

    expect(listener).not.toHaveBeenCalled()
    releases.forEach((release) => release())
  })

  it('delivers each capacity notification at most once', () => {
    const releases = fillWatcherChildCapacity()
    const listener = vi.fn()
    onWatcherChildCapacityAvailable(listener)

    releases.pop()?.()
    releases.pop()?.()

    expect(listener).toHaveBeenCalledOnce()
    releases.forEach((release) => release())
  })

  it('hands one released slot to one reserving waiter at a time', async () => {
    const releases = fillWatcherChildCapacity()
    let firstReservation: (() => void) | null = null
    let secondReservation: (() => void) | null = null
    const first = vi.fn(() => {
      firstReservation = reserveWatcherChild()
    })
    const second = vi.fn(() => {
      secondReservation = reserveWatcherChild()
    })
    onWatcherChildCapacityAvailable(first)
    onWatcherChildCapacityAvailable(second)

    releases.pop()?.()
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
    expect(firstReservation).toBeTypeOf('function')
    expect(second).not.toHaveBeenCalled()

    ;(firstReservation as (() => void) | null)?.()
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce())
    expect(secondReservation).toBeTypeOf('function')

    ;(secondReservation as (() => void) | null)?.()
    releases.forEach((release) => release())
  })
})
