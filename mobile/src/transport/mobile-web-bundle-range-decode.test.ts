import { gzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'
import { decodeMobileWebBundleRange } from './mobile-web-bundle-range-decode'

const RAW = Uint8Array.from({ length: 20_000 }, (_, index) => (index * 31) % 7)
const GZIP = gzipSync(RAW, { level: 6 })
const RANGE = { path: 'assets/a.js', offset: 0, encoding: 'gzip' }

function refusalOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof MobileWebBundleFetchError ? error.refusal : 'untyped'
  }
}

describe('decoding a bundle range', () => {
  it('inflates a gzip range to exactly the window it answered', () => {
    expect(GZIP.byteLength).toBeLessThan(RAW.byteLength)
    expect(decodeMobileWebBundleRange(RANGE, GZIP, RAW.byteLength)).toEqual(RAW)
  })

  it('passes an identity range through', () => {
    expect(
      decodeMobileWebBundleRange({ ...RANGE, encoding: 'identity' }, RAW, RAW.byteLength)
    ).toEqual(RAW)
  })

  it('refuses a truncated gzip body', () => {
    expect(
      refusalOf(() =>
        decodeMobileWebBundleRange(RANGE, GZIP.subarray(0, GZIP.byteLength - 20), RAW.byteLength)
      )
    ).toBe('range-undecodable')
  })

  it('refuses a body that is not gzip at all', () => {
    expect(
      refusalOf(() => decodeMobileWebBundleRange(RANGE, Uint8Array.of(1, 2, 3), RAW.byteLength))
    ).toBe('range-undecodable')
  })

  it('refuses an encoding this build cannot decode', () => {
    expect(
      refusalOf(() =>
        decodeMobileWebBundleRange({ ...RANGE, encoding: 'br' }, GZIP, RAW.byteLength)
      )
    ).toBe('range-undecodable')
  })

  // The spare byte in the bounded buffer is what lets the fetch's slot check see an overlong body.
  it('stops a gzip body that inflates past the window one byte over it', () => {
    expect(decodeMobileWebBundleRange(RANGE, GZIP, RAW.byteLength - 100).byteLength).toBe(
      RAW.byteLength - 99
    )
  })

  it('hands back a gzip body that inflates short of the window as it is', () => {
    expect(decodeMobileWebBundleRange(RANGE, GZIP, RAW.byteLength + 100).byteLength).toBe(
      RAW.byteLength
    )
  })
})
