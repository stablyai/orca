import { describe, expect, it } from 'vitest'
import {
  assertBrowserScreenshotEncodedBytes,
  assertBrowserScreenshotGeometry,
  BROWSER_SCREENSHOT_MAX_EFFECTIVE_PIXELS,
  BROWSER_SCREENSHOT_MAX_ENCODED_BYTES,
  BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR
} from './browser-screenshot-limits'

describe('browser screenshot memory limits', () => {
  it('accepts ordinary HiDPI viewport geometry', () => {
    expect(() => assertBrowserScreenshotGeometry(1_440, 900, 2)).not.toThrow()
  })

  it('counts device scale in the effective pixel budget', () => {
    const side = Math.floor(Math.sqrt(BROWSER_SCREENSHOT_MAX_EFFECTIVE_PIXELS))

    expect(() => assertBrowserScreenshotGeometry(side, side, 2)).toThrow(
      BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR
    )
  })

  it('accepts the encoded-byte boundary and rejects the next byte', () => {
    expect(() =>
      assertBrowserScreenshotEncodedBytes(BROWSER_SCREENSHOT_MAX_ENCODED_BYTES)
    ).not.toThrow()
    expect(() =>
      assertBrowserScreenshotEncodedBytes(BROWSER_SCREENSHOT_MAX_ENCODED_BYTES + 1)
    ).toThrow(BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
  })
})
