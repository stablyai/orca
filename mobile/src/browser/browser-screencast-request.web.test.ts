import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { buildMobileBrowserScreencastRequest } from './browser-screencast-request'
import {
  base64Characters,
  binaryEventEnvelopeBytes,
  budgetedMobileViewDeviceScaleFactor,
  buildMobileBrowserScreencastRequest as buildOnWeb,
  WORST_CASE_JPEG_BYTES_PER_PIXEL
} from './browser-screencast-request.web'

/** A phone's measured browser area, in CSS pixels. */
const PHONE = { width: 390, height: 712 }

/** What the shell would have to post for a frame of this area at the worst case JPEG has. */
function frameMessageBytes(areaPixels: number): number {
  const imageBytes = Math.ceil(areaPixels * WORST_CASE_JPEG_BYTES_PER_PIXEL)
  return base64Characters(imageBytes) + binaryEventEnvelopeBytes()
}

function mobileFrameArea(
  layout: { width: number; height: number },
  request: { deviceScaleFactor?: number } | null
): number {
  const scale = request?.deviceScaleFactor
  if (scale === undefined) {
    throw new Error('the request carried no device scale factor')
  }
  return Math.round(layout.width) * Math.round(layout.height) * scale * scale
}

describe('the mobile-view area budget', () => {
  // The control, and the reason the budget exists: what the native request asks for on this same
  // phone does not fit in one bridge message, and the shell would answer it with a dropped frame.
  it('is needed: the native request overflows the frame cap on a phone', () => {
    const native = buildMobileBrowserScreencastRequest(PHONE, 2, 'mobile')

    expect(native?.deviceScaleFactor).toBe(2)
    expect(frameMessageBytes(mobileFrameArea(PHONE, native))).toBeGreaterThan(
      BRIDGE_MAX_MESSAGE_BYTES
    )
  })

  it('keeps the worst case frame inside one bridge message', () => {
    const budgeted = buildOnWeb(PHONE, 2, 'mobile')

    expect(frameMessageBytes(mobileFrameArea(PHONE, budgeted))).toBeLessThanOrEqual(
      BRIDGE_MAX_MESSAGE_BYTES
    )
  })

  it('uses the largest hundredth of density whose frame fits the cap', () => {
    const scale = budgetedMobileViewDeviceScaleFactor(PHONE)
    expect(
      frameMessageBytes(mobileFrameArea(PHONE, { deviceScaleFactor: scale + 0.01 }))
    ).toBeGreaterThan(BRIDGE_MAX_MESSAGE_BYTES)
  })

  it('leaves web mode byte-identical to the native request', () => {
    expect(buildOnWeb(PHONE, 2, 'web')).toEqual(
      buildMobileBrowserScreencastRequest(PHONE, 2, 'web')
    )
    expect(buildOnWeb(PHONE, 2)).toEqual(buildMobileBrowserScreencastRequest(PHONE, 2))
  })

  it('never asks for more density than native, on a viewport the budget does not bind', () => {
    expect(budgetedMobileViewDeviceScaleFactor({ width: 200, height: 200 })).toBe(2)
  })

  it('stops at one device pixel per CSS pixel on a viewport no scale would fit', () => {
    // Past this the page would be asking for a blurrier frame than its own layout; a frame that
    // still does not fit is C6 ruling 1's to drop.
    expect(budgetedMobileViewDeviceScaleFactor({ width: 2000, height: 1400 })).toBe(1)
  })

  it('answers the native factor when there is no layout to budget against', () => {
    expect(budgetedMobileViewDeviceScaleFactor(null)).toBe(2)
    expect(buildOnWeb(null, 2, 'mobile')).toBeNull()
    expect(buildOnWeb({ width: 0, height: 712 }, 2, 'mobile')).toBeNull()
  })
})

it('counts base64 padding for an image that does not fill its last group', () => {
  expect(base64Characters(3001)).toBe(4004)
})

describe('web-mode request work', () => {
  for (const mode of [undefined, 'web'] as const) {
    it(`skips discarded mobile density work in ${mode ?? 'default'} view`, () => {
      const layouts = [
        { width: 360, height: 640 },
        { width: 390, height: 712 },
        { width: 402, height: 593 },
        { width: 319.49, height: 239.51 },
        { width: 1200, height: 1200 },
        { width: 2000, height: 1400 }
      ]
      const expected = layouts.map((layout) => buildMobileBrowserScreencastRequest(layout, 2, mode))
      const stringify = vi.spyOn(JSON, 'stringify')
      const sqrt = vi.spyOn(Math, 'sqrt')
      let actual: ReturnType<typeof buildOnWeb>[] = []
      let envelopeCalls = 0
      let sqrtCalls = 0
      try {
        actual = layouts.map((layout) => buildOnWeb(layout, 2, mode))
        envelopeCalls = stringify.mock.calls.length
        sqrtCalls = sqrt.mock.calls.length
      } finally {
        stringify.mockRestore()
        sqrt.mockRestore()
      }

      expect(actual).toEqual(expected)
      expect(envelopeCalls).toBe(0)
      expect(sqrtCalls).toBe(0)
    })
  }
})
