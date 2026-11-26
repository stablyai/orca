import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./grab-guest-execution', () => ({
  grabDocumentScope: () => ({ current: true }),
  restoreGrabCapture: () => {},
  // The picked element sits still, so the prepare and post-capture snapshots agree.
  requestGrabExecution: async () => ({
    ok: true,
    value: { x: 0, y: 0, width: 4, height: 4, viewportWidth: 8 }
  })
}))

import {
  captureSelectionScreenshot,
  SELECTION_CAPTURE_DEADLINE_MS
} from './browser-grab-screenshot'
import {
  isNativeCaptureBusy,
  occupyNativeCaptureLane
} from '../../window/visibility/native-capture-lane'

afterEach(() => vi.useRealTimers())

const image = {
  isEmpty: () => false,
  getSize: () => ({ width: 8, height: 8 }),
  crop: () => ({ toPNG: () => Buffer.from('png') })
}

function guestWithReadbacks(): { guest: Electron.WebContents; settle: (() => void)[] } {
  const settle: (() => void)[] = []
  const guest = {
    isDestroyed: () => false,
    capturePage: () =>
      new Promise((resolve) => {
        settle.push(() => resolve(image))
      })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only the members above.
  return { guest: guest as unknown as Electron.WebContents, settle }
}

it('waits for a native capture already in flight on the guest before submitting its readback', async () => {
  vi.useFakeTimers()
  const { guest, settle } = guestWithReadbacks()
  let freeDraw: () => void = () => {}
  occupyNativeCaptureLane(
    guest,
    new Promise<void>((resolve) => {
      freeDraw = resolve
    })
  )
  const paint: string[] = []
  const shot = captureSelectionScreenshot({ x: 0, y: 0, width: 4, height: 4 }, guest, 'sel', () => {
    paint.push('hold')
    return () => paint.push('release')
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(settle).toHaveLength(0)

  freeDraw()
  await vi.advanceTimersByTimeAsync(0)
  expect(settle).toHaveLength(1)
  settle[0]()
  await expect(shot).resolves.toMatchObject({ mimeType: 'image/png', width: 4, height: 4 })
  expect(paint).toEqual(['hold', 'release'])
})

it('keeps the lane and the paint lease after its deadline until the abandoned readback settles', async () => {
  vi.useFakeTimers()
  const { guest, settle } = guestWithReadbacks()
  const paint: string[] = []
  const shot = captureSelectionScreenshot({ x: 0, y: 0, width: 4, height: 4 }, guest, 'sel', () => {
    paint.push('hold')
    return () => paint.push('release')
  })
  await vi.advanceTimersByTimeAsync(SELECTION_CAPTURE_DEADLINE_MS)
  await expect(shot).resolves.toBeNull()
  // A Draw readback submitted now would overlap the one still in flight.
  expect(isNativeCaptureBusy(guest)).toBe(true)
  expect(paint).toEqual(['hold'])

  settle[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(isNativeCaptureBusy(guest)).toBe(false)
  expect(paint).toEqual(['hold', 'release'])
})

it('crops a box partly off the top-left to the visible part of the element only', async () => {
  const { selectionCropRect } = await import('./browser-grab-screenshot')
  // 2x bitmap; the element spans x -10..40, y -5..15 in CSS pixels.
  expect(
    selectionCropRect({ x: -10, y: -5, width: 50, height: 20 }, 2, { width: 400, height: 300 })
  ).toEqual({ x: 0, y: 0, width: 80, height: 30 })
  // And off the bottom-right edge of the bitmap.
  expect(
    selectionCropRect({ x: 180, y: 140, width: 50, height: 20 }, 2, { width: 400, height: 300 })
  ).toEqual({ x: 360, y: 280, width: 40, height: 20 })
})
