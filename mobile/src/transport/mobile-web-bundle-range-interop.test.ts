import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { encodeMobileWebBundleRange } from '../../../src/main/runtime/rpc/methods/mobile-web-bundle-range-encoding'
import { MOBILE_WEB_BUNDLE_RANGE_BYTES } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'

/** Script-like and a full range long, so the host's level-6 deflate emits dynamic Huffman blocks. */
function scriptRange(): Buffer {
  const words = ['const ', 'function ', 'return ', 'export ', '=> ', '{', '}', ';\n', 'orca']
  let text = ''
  for (let index = 0; text.length < MOBILE_WEB_BUNDLE_RANGE_BYTES; index += 1) {
    text += words[(index * 7) % words.length] + String(index % 1000)
  }
  return Buffer.from(text.slice(0, MOBILE_WEB_BUNDLE_RANGE_BYTES))
}

// The host deflates with node's zlib and the phone inflates with fflate: two implementations that
// must agree on every range the host can send.
describe('a host-encoded range decoded by the phone', () => {
  it('inflates node gzip output with fflate to the same bytes', async () => {
    const raw = scriptRange()
    const encoded = await encodeMobileWebBundleRange(raw)

    expect(encoded.encoding).toBe('gzip')
    const inflated = gunzipSync(new Uint8Array(encoded.bytes), {
      out: new Uint8Array(raw.byteLength + 1)
    })
    expect(Buffer.from(inflated).equals(raw)).toBe(true)
  })

  it('leaves incompressible bytes as identity, which needs no decoder', async () => {
    const raw = randomBytes(4096)
    const encoded = await encodeMobileWebBundleRange(raw)

    expect(encoded.encoding).toBe('identity')
    expect(encoded.bytes.equals(raw)).toBe(true)
  })
})
