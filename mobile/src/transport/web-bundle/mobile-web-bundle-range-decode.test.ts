import { gzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { decodeMobileWebBundleRange } from './mobile-web-bundle-range-decode'

const RAW = Uint8Array.from({ length: 20_000 }, (_, index) => (index * 31) % 7)
const GZIP = gzipSync(RAW, { level: 6 })
const RANGE = { path: 'assets/a.js', offset: 0, encoding: 'gzip' }

describe('decoding a bundle range', () => {
  it('inflates a gzip range to exactly the window it answered', () => {
    expect(GZIP.byteLength).toBeLessThan(RAW.byteLength)
    expect(decodeMobileWebBundleRange(RANGE, GZIP, RAW.byteLength)).toEqual(RAW)
  })

  // The spare byte in the bounded buffer is what lets the fetch's slot check see an overlong body.
  it('stops a gzip body that inflates past the window one byte over it', () => {
    expect(decodeMobileWebBundleRange(RANGE, GZIP, RAW.byteLength - 100).byteLength).toBe(
      RAW.byteLength - 99
    )
  })
})
