import { decompressSessionZstdFrames } from './session-zstd-frames'

export function decompressDshFrames(bytes: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  return decompressSessionZstdFrames(bytes, {
    provider: 'DSH',
    compressedBytes: 32 * 1024 * 1024,
    decodedBytes: 64 * 1024 * 1024,
    windowLogMax: 26
  })
}
