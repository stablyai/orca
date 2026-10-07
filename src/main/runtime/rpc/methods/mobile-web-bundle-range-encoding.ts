import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { MobileWebBundleRangeEncoding } from '../../../../shared/mobile-web-bundle/bundle-rpc-contract'

// Async so a 384 KiB deflate runs on the libuv pool, not the main process's event loop.
const gzipAsync = promisify(gzip)

/** Level 6 measured 2.22 MB for the 7.70 MB bundle; identity whenever gzip does not shrink,
 *  which is also what keeps the reply under the range's frame bound. */
export async function encodeMobileWebBundleRange(
  data: Buffer
): Promise<{ encoding: MobileWebBundleRangeEncoding; bytes: Buffer }> {
  if (data.byteLength === 0) {
    return { encoding: 'identity', bytes: data }
  }
  const compressed = await gzipAsync(data, { level: 6 })
  return compressed.byteLength < data.byteLength
    ? { encoding: 'gzip', bytes: compressed }
    : { encoding: 'identity', bytes: data }
}
