import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH,
  MOBILE_WEB_BUNDLE_RANGE_METHOD
} from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import { MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { mobileWebBundleRangeRead } from './mobile-web-bundle-operations'

function rangeReply(overrides: Record<string, unknown> = {}) {
  return {
    buildId: 'a'.repeat(64),
    path: 'index.html',
    offset: 0,
    assetByteLength: 12,
    sha256: 'b'.repeat(64),
    encoding: 'gzip',
    dataBase64: 'aGVsbG8=',
    eof: true,
    ...overrides
  }
}

describe('mobile web bundle range reply reader', () => {
  it('reads a range and passes an unknown member through', () => {
    const result = mobileWebBundleRangeRead.read({ ...rangeReply(), later: 1 })

    expect(result.compatible).toBe(true)
    if (!result.compatible) {
      return
    }
    expect(result.variant).toBe('mobile-web-bundle-range')
    expect(result.value).toMatchObject({ encoding: 'gzip', later: 1 })
  })

  // Refusing it here would fail with a shape error; the decoder names the encoding instead.
  it('reads an encoding this build does not know through to the decoder', () => {
    expect(mobileWebBundleRangeRead.read(rangeReply({ encoding: 'br' })).compatible).toBe(true)
  })

  it('bounds dataBase64 at the range size the contract allows', () => {
    const at = 'A'.repeat(MOBILE_WEB_BUNDLE_RANGE_MAX_DATA_BASE64_LENGTH)
    expect(mobileWebBundleRangeRead.read(rangeReply({ dataBase64: at })).compatible).toBe(true)
    expect(mobileWebBundleRangeRead.read(rangeReply({ dataBase64: `${at}A` })).compatible).toBe(
      false
    )
  })

  it('requires every member that makes a range self-describing', () => {
    for (const overrides of [
      { buildId: 'nope' },
      { path: '../escape.js' },
      { offset: -1 },
      { assetByteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES + 1 },
      { sha256: 'b'.repeat(63) },
      { encoding: undefined },
      { encoding: '' },
      { dataBase64: undefined },
      { eof: undefined }
    ]) {
      expect(mobileWebBundleRangeRead.read(rangeReply(overrides)).compatible).toBe(false)
    }
  })

  it('is a require-result read of the range method', () => {
    expect(mobileWebBundleRangeRead.method).toBe(MOBILE_WEB_BUNDLE_RANGE_METHOD)
    expect(mobileWebBundleRangeRead.acceptance).toBe('require-result-or-throw')
    expect(mobileWebBundleRangeRead.barrier).toBe('on-settle')
  })
})
