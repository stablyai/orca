import { Z_FINISH, Z_OK, Z_STREAM_END } from 'pako/lib/zlib/constants.js'
import { inflate, inflateEnd, inflateInit2 } from 'pako/lib/zlib/inflate.js'
import ZStream from 'pako/lib/zlib/zstream.js'

export function inflateCatalogGzip(
  input: Uint8Array,
  expectedBytes: number,
  maxBytes: number
): Uint8Array {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) {
    throw new Error('invalid catalog gzip output size')
  }
  const stream = new ZStream()
  // gzip-only mode verifies the member's CRC32 and ISIZE before returning Z_STREAM_END.
  if (inflateInit2(stream, 31) !== Z_OK) {
    throw new Error('could not initialize catalog inflater')
  }
  try {
    stream.input = input
    stream.avail_in = input.length
    stream.output = new Uint8Array(expectedBytes + 1)
    stream.avail_out = stream.output.length
    if (
      inflate(stream, Z_FINISH) !== Z_STREAM_END ||
      stream.avail_in !== 0 ||
      stream.next_out !== expectedBytes
    ) {
      throw new Error('invalid catalog gzip member')
    }
    return stream.output.subarray(0, expectedBytes)
  } finally {
    inflateEnd(stream)
  }
}
