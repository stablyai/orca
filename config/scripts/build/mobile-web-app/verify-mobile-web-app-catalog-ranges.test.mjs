import { expect, it } from 'vitest'
import {
  assertHostCatalogsFitRanges,
  readHostCatalogLimits
} from './verify-mobile-web-app-bundle.mjs'

  it('admits a host catalog over one reply that ranges carry, within the frame and total caps', async () => {
    const limits = await readHostCatalogLimits()
    const catalog = (byteLength) => ({ locale: 'ru', byteLength })

    // A complete Russian catalog: over the 384 KiB one reply carried.
    expect(() => assertHostCatalogsFitRanges([catalog(435_780)], limits)).not.toThrow()
    expect(() => assertHostCatalogsFitRanges([catalog(limits.maxBytes + 1)], limits)).toThrow(
      'the ru host catalog is'
    )
    expect(() => assertHostCatalogsFitRanges([], { ...limits, rangeBytes: 640 * 1024 })).toThrow(
      'relay frame'
    )
  })
