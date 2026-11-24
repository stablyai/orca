import { afterEach, expect, it, vi } from 'vitest'
import { captureCleanGuestPage } from './grab-clean-page-capture'
import { RendererPublicationThrottle } from '../../window/visibility/renderer-publication-throttle'

afterEach(() => vi.useRealTimers())

const image = {
  isEmpty: () => false,
  toDataURL: () => 'data:image/png;base64,AA',
  getSize: () => ({ width: 8, height: 8 })
}
const captured = { dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 }

it('abandons a stalled readback at its deadline, and starts no second readback until it settles', async () => {
  vi.useFakeTimers()
  const readbacks: (() => void)[] = []
  const guest = {
    isDestroyed: () => false,
    capturePage: () =>
      new Promise<typeof image>((resolve) => {
        readbacks.push(() => resolve(image))
      })
  }
  const paint: string[] = []
  const holdPaint = (): (() => void) => {
    paint.push('hold')
    return () => paint.push('release')
  }

  const stalled = captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(stalled).resolves.toBeNull()
  // Draw gives up, but paint stays held while the native readback is still in flight.
  expect(paint).toEqual(['hold'])

  // The abandoned readback still owns the guest's capture lane: the next Draw waits, then gives up.
  const second = captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(second).resolves.toBeNull()
  expect(readbacks).toHaveLength(1)
  expect(paint).toEqual(['hold', 'hold', 'release'])

  readbacks[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(paint).toEqual(['hold', 'hold', 'release', 'release'])
  const next = captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  await vi.advanceTimersByTimeAsync(0)
  readbacks[1]()
  await expect(next).resolves.toEqual(captured)
})

it('never overlaps Draw readbacks with the paint lease restore capture, in either order', async () => {
  vi.useFakeTimers()
  const throttle = new RendererPublicationThrottle()
  const calls: string[] = []
  const pending: { readback: (() => void)[]; restore: (() => void)[] } = {
    readback: [],
    restore: []
  }
  const throttling: boolean[] = []
  const guest = {
    isDestroyed: () => false,
    isFocused: () => false,
    setBackgroundThrottling: (allowed: boolean) => throttling.push(allowed),
    capturePage: (rect?: unknown) => {
      const kind = rect ? 'restore' : 'readback'
      calls.push(kind)
      return new Promise<typeof image>((resolve) => {
        pending[kind].push(() => resolve(image))
      })
    }
  }
  const leases: boolean[] = []
  throttle.observe(guest, (leased) => leases.push(leased))
  const draw = (): ReturnType<typeof captureCleanGuestPage> =>
    captureCleanGuestPage(
      guest,
      new AbortController().signal,
      () => throttle.acquire(guest),
      1_000,
      5_000
    )

  // Draw abandons its readback at the deadline; the paint cap then releases the lease exactly once.
  const abandoned = draw()
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(abandoned).resolves.toBeNull()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(leases).toEqual([true, false])
  // The guest is throttled again at once, while only its rehide capture waits for the readback.
  await vi.advanceTimersByTimeAsync(100)
  expect(throttling).toEqual([false, true])
  expect(calls).toEqual(['readback'])

  // Draws that time out behind the stalled readback submit nothing of their own.
  for (let i = 0; i < 3; i++) {
    const waiting = draw()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(waiting).resolves.toBeNull()
  }
  await vi.advanceTimersByTimeAsync(100)
  expect(calls).toEqual(['readback'])
  expect(throttling.at(-1)).toBe(true)

  pending.readback[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(['readback', 'restore'])

  // The restore is still pending when the next Draw starts: Draw waits for it, then captures.
  const next = draw()
  await vi.advanceTimersByTimeAsync(100)
  expect(calls).toEqual(['readback', 'restore'])
  pending.restore[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(['readback', 'restore', 'readback'])
  pending.readback[1]()
  await expect(next).resolves.toEqual(captured)
})

it('owes one rehide per final release, and a lease held when the readback settles postpones it', async () => {
  vi.useFakeTimers()
  const throttle = new RendererPublicationThrottle()
  const calls: string[] = []
  const readbacks: (() => void)[] = []
  const guest = {
    isDestroyed: () => false,
    isFocused: () => false,
    setBackgroundThrottling: () => {},
    capturePage: (rect?: unknown) => {
      calls.push(rect ? 'restore' : 'readback')
      return rect
        ? Promise.resolve(image)
        : new Promise<typeof image>((resolve) => {
            readbacks.push(() => resolve(image))
          })
    }
  }
  const draw = (): ReturnType<typeof captureCleanGuestPage> =>
    captureCleanGuestPage(
      guest,
      new AbortController().signal,
      () => throttle.acquire(guest),
      1_000,
      5_000
    )

  // Past the deadline and the paint cap: the rehide is owed behind the pending readback.
  void draw()
  await vi.advanceTimersByTimeAsync(6_100)
  // Another lease starts and ends; the readback settles before that release's restore timer runs.
  throttle.acquire(guest)()
  readbacks[0]()
  // Let the settlement run to completion before that timer fires.
  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
  }
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(['readback', 'restore'])

  // A lease still held when the next abandoned readback settles postpones the rehide to its own release.
  void draw()
  await vi.advanceTimersByTimeAsync(6_100)
  const release = throttle.acquire(guest)
  readbacks[1]()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(['readback', 'restore', 'readback'])
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(['readback', 'restore', 'readback', 'restore'])
})

it('leaves the guest usable for the next Draw when taking the paint lease fails', async () => {
  const guest = { isDestroyed: () => false, capturePage: () => Promise.resolve(image) }
  await expect(
    captureCleanGuestPage(guest, new AbortController().signal, () => {
      throw new Error('parent renderer lease failed')
    })
  ).resolves.toBeNull()
  await expect(
    captureCleanGuestPage(guest, new AbortController().signal, () => () => {})
  ).resolves.toEqual(captured)
})
