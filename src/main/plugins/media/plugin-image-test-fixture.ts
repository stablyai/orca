import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { PluginImageCache } from './plugin-image-cache'

/** Header-valid PNG data for acceptance tests; it is not a rendered/decoded-image fixture. */
export function pngImageBytes(width: number, height: number, size = 128, seed = 0): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  bytes.writeUInt32BE(size - 45, 33)
  bytes.write('IDAT', 37)
  bytes.writeUInt32BE(seed, 41)
  return bytes
}

export function catalogImageFixture(path: string, bytes: Buffer) {
  return {
    path,
    alt: 'Plugin preview',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  }
}

const imageCacheWrites: Promise<unknown>[] = []

/** Records every image cache write; install it in `beforeEach`, since mock restores remove it. */
export function trackImageCacheWrites(): void {
  const put = PluginImageCache.prototype.put
  vi.spyOn(PluginImageCache.prototype, 'put').mockImplementation(function (
    this: PluginImageCache,
    bytes
  ) {
    const write = put.call(this, bytes)
    imageCacheWrites.push(write)
    return write
  })
}

/** Delivery does not wait for its cache write, so a test settles writes before reading the cache
 *  or removing its directory. */
export async function settleImageCacheWrites(): Promise<void> {
  while (imageCacheWrites.length > 0) {
    await Promise.allSettled(imageCacheWrites.splice(0))
  }
}
