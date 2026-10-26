import { gunzipSync } from 'fflate'
import { pairedE2EENativeCodec } from './paired-e2ee-native-codec'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'

// Inflate into a fixed buffer one byte past the slot so gzip bombs stay memory-bounded and length checks can reject excess.
// Native decoding also rejects bad CRC/length/trailing bytes; Node-zlib host output needs none of that fallback leniency.
export function decodeMobileWebBundleRange(
  range: { readonly path: string; readonly offset: number; readonly encoding: string },
  wire: Uint8Array,
  expectedLength: number
): Uint8Array {
  if (range.encoding === 'identity') {
    return wire
  }
  if (range.encoding !== 'gzip') {
    throw new MobileWebBundleFetchError(
      'range-undecodable',
      `bundle range of ${range.path} at ${range.offset} arrived in unknown encoding ${range.encoding}`
    )
  }
  try {
    const native = pairedE2EENativeCodec()
    return native
      ? native.gunzip(wire, expectedLength + 1)
      : gunzipSync(wire, { out: new Uint8Array(expectedLength + 1) })
  } catch (error) {
    throw new MobileWebBundleFetchError(
      'range-undecodable',
      `bundle range of ${range.path} at ${range.offset} is not valid gzip: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
