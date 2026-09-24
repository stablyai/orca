import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { METADATA_KEYS } from '../transport/browser-screencast-protocol'
import { buildMobileBrowserScreencastRequest } from './browser-screencast-request'
import {
  BASE64_BYTES_PER_CHARACTER,
  base64Characters,
  binaryEventEnvelopeBytes,
  budgetedMobileViewDeviceScaleFactor,
  buildMobileBrowserScreencastRequest as buildOnWeb,
  mobileBrowserFrameAreaBudget,
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

  // Derived from the same constants the module derives from, not written down: a budget the test
  // restates is a budget that agrees with itself and with nothing else.
  it('asks for the scale the cap and the worst case together allow', () => {
    const expected = Math.sqrt(mobileBrowserFrameAreaBudget() / (PHONE.width * PHONE.height))

    const scale = budgetedMobileViewDeviceScaleFactor(PHONE)

    expect(scale).toBeLessThanOrEqual(expected)
    // Floored to two decimals, so it is the largest such scale rather than merely a safe one.
    expect(scale).toBeGreaterThan(expected - 0.01)
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

describe('the budget derivation', () => {
  it('spends the whole cap that the envelope leaves', () => {
    const available = BRIDGE_MAX_MESSAGE_BYTES - binaryEventEnvelopeBytes()
    const expectedArea = Math.floor(
      (Math.floor(available / 4) * 3) / WORST_CASE_JPEG_BYTES_PER_PIXEL
    )

    expect(mobileBrowserFrameAreaBudget()).toBe(expectedArea)
    // The ratio alone can claim two bytes base64 does not have, which at this margin is a frame
    // the shell drops rather than sends.
    expect(Math.floor(available / 4) * 3).toBeLessThanOrEqual(
      Math.floor(available * BASE64_BYTES_PER_CHARACTER)
    )
  })

  /**
   * Why the budget counts whole base64 groups rather than three quarters of the room.
   *
   * The two agree at today's envelope size, because the room it leaves happens to divide by four.
   * They do not agree in general, and the budget now spends the cap exactly, so the first envelope
   * change that lands on another remainder would hand the shell a frame two characters over.
   */
  it('counts base64 padding, which the ratio does not for every image size', () => {
    expect(base64Characters(3001)).toBe(4004)
    expect(Math.ceil(3001 / BASE64_BYTES_PER_CHARACTER)).toBe(4002)
    // Same statement from the budget's side: room for 4002 characters is not room for 3001 bytes.
    expect(Math.floor(4002 / 4) * 3).toBeLessThan(Math.floor(4002 * BASE64_BYTES_PER_CHARACTER))
  })

  // The budget spends the cap exactly, so anything the expansion under-counts is a dropped frame.
  it('leaves a frame of exactly the budgeted area inside the cap, padding included', () => {
    expect(frameMessageBytes(mobileBrowserFrameAreaBudget())).toBeLessThanOrEqual(
      BRIDGE_MAX_MESSAGE_BYTES
    )
  })

  it('measures the envelope rather than naming a number, and leaves it room to grow', () => {
    const envelope = binaryEventEnvelopeBytes()

    // Big enough to be the real shape, small enough that the budget is not swallowed by it.
    expect(envelope).toBeGreaterThan(200)
    expect(envelope).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES / 100)
  })
})

/**
 * The widest a finite double serializes as: sign, `0.`, the five zeros fixed notation writes just
 * above 1e-6, and seventeen significant digits. Exponential form is one shorter, because ToString
 * only leaves fixed notation below 1e-6.
 */
const WIDEST_JSON_DOUBLE = -0.000001234567890123456_7

/** A frame event with nothing in it but the widest every field can be, and no image. */
function widestEnvelope(metadataValue: number): string {
  return JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    id: 'a'.repeat(22),
    seq: Number.MAX_SAFE_INTEGER,
    binary: {
      b64: '',
      format: 'jpeg',
      frameSeq: Number.MAX_SAFE_INTEGER,
      metadata: Object.fromEntries(METADATA_KEYS.map((key) => [key, metadataValue]))
    }
  })
}

describe('the envelope bound', () => {
  // The budget's whole margin is whatever this over-estimates by, so an under-estimate is a frame
  // over the cap rather than a rounding difference.
  it('is at least what a real frame event costs at its widest', () => {
    expect(binaryEventEnvelopeBytes()).toBeGreaterThanOrEqual(
      widestEnvelope(WIDEST_JSON_DOUBLE).length
    )
  })

  it('is a bound on every finite double, not on the one it was written with', () => {
    // Deterministic rather than seeded off the clock: a bound that fails one run in a thousand is
    // a bound nobody believes. Bit patterns for the exponential forms, then the band just above
    // 1e-6 where fixed notation is widest.
    const bits = new ArrayBuffer(8)
    const asDouble = new Float64Array(bits)
    const asBits = new BigUint64Array(bits)
    let state = 0x9e37_79b9n
    const next = (): bigint => {
      state =
        (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & 0xffff_ffff_ffff_ffffn
      return state
    }
    let widest = 0
    for (let index = 0; index < 200_000; index += 1) {
      asBits[0] = next()
      const value = asDouble[0]
      if (Number.isFinite(value)) {
        widest = Math.max(widest, JSON.stringify(value).length)
      }
      const nearTheBoundary = -(1e-6 + Number(next() % 9_000_000n) * 1e-12)
      widest = Math.max(widest, JSON.stringify(nearTheBoundary).length)
    }

    expect(widest).toBe(JSON.stringify(WIDEST_JSON_DOUBLE).length)
    expect(binaryEventEnvelopeBytes()).toBeGreaterThanOrEqual(
      widestEnvelope(WIDEST_JSON_DOUBLE).length
    )
  })

  // Not the other way round either: an envelope bound big enough to be safe and loose enough to
  // cost real pixels is a budget nobody can reason about.
  it('is not loose: it is within a metadata field of what that costs', () => {
    const widest = widestEnvelope(WIDEST_JSON_DOUBLE).length

    expect(binaryEventEnvelopeBytes() - widest).toBeLessThan(
      JSON.stringify(WIDEST_JSON_DOUBLE).length
    )
  })
})
