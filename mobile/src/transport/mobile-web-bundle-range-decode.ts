import { gunzipSync } from 'fflate'
import { pairedE2EENativeCodec } from './paired-e2ee-native-codec'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'

/**
 * The raw bytes of one range, from the `dataBase64` bytes the host sent under `encoding`.
 *
 * Inflated into a buffer one byte past the window: fflate fills a supplied `out` and never grows it,
 * so a gzip bomb is bounded in memory, not in the time spent inflating. A wrong length is left to the
 * fetch's slot checks, where a filled spare byte reads as overlong.
 *
 * The native codec is stricter than fflate: it also refuses a bad CRC or length, and bytes after
 * the member. No host sends those, since every host gzips with node:zlib.
 */
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
