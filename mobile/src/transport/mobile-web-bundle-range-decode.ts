import { gunzipSync } from 'fflate'
import { MobileWebBundleFetchError } from './mobile-web-bundle-fetch-refusal'

/**
 * The raw bytes of one range, from the `dataBase64` bytes the host sent under `encoding`.
 *
 * Inflated into a buffer one byte past the window: fflate fills a supplied `out` and never grows it,
 * so a gzip bomb costs at most that much memory (not time: inflating still runs to the body's end),
 * and a body that fills the spare byte is overlong.
 */
export function decodeMobileWebBundleRange(
  range: { readonly path: string; readonly offset: number; readonly encoding: string },
  wire: Uint8Array,
  expectedLength: number
): Uint8Array {
  const bytes = inflate(range, wire, expectedLength)
  if (bytes.byteLength !== expectedLength) {
    throw new MobileWebBundleFetchError(
      'range-length-mismatch',
      `bundle range of ${range.path} at ${range.offset} decoded to ${bytes.byteLength} bytes, not ${expectedLength}`
    )
  }
  return bytes
}

function inflate(
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
    return gunzipSync(wire, { out: new Uint8Array(expectedLength + 1) })
  } catch (error) {
    throw new MobileWebBundleFetchError(
      'range-undecodable',
      `bundle range of ${range.path} at ${range.offset} is not valid gzip: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
