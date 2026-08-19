import { Transform } from 'node:stream'
import { crc32 } from 'node:zlib'

const DEFLATE_STORED_BLOCK_BYTES = 65_535
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff])

function storedDeflateBlock(bytes: Buffer, final: boolean): Buffer {
  const output = Buffer.allocUnsafe(bytes.length + 5)
  output[0] = final ? 1 : 0
  output.writeUInt16LE(bytes.length, 1)
  output.writeUInt16LE(~bytes.length & 0xffff, 3)
  bytes.copy(output, 5)
  return output
}

// zlib streaming decisions vary by bundled version; stored blocks keep archive identity portable.
export function createDeterministicGzipStore(): Transform {
  const pending = Buffer.allocUnsafe(DEFLATE_STORED_BLOCK_BYTES)
  let pendingBytes = 0
  let checksum = 0
  let inputBytes = 0
  let headerWritten = false
  const encoder = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!headerWritten) {
        encoder.push(GZIP_HEADER)
        headerWritten = true
      }
      checksum = crc32(chunk, checksum)
      inputBytes = (inputBytes + chunk.length) >>> 0
      let offset = 0
      while (offset < chunk.length) {
        const copied = Math.min(pending.length - pendingBytes, chunk.length - offset)
        chunk.copy(pending, pendingBytes, offset, offset + copied)
        pendingBytes += copied
        offset += copied
        if (pendingBytes === pending.length) {
          encoder.push(storedDeflateBlock(pending, false))
          pendingBytes = 0
        }
      }
      callback()
    },
    flush(callback) {
      if (!headerWritten) {
        encoder.push(GZIP_HEADER)
      }
      encoder.push(storedDeflateBlock(pending.subarray(0, pendingBytes), true))
      const trailer = Buffer.allocUnsafe(8)
      trailer.writeUInt32LE(checksum >>> 0, 0)
      trailer.writeUInt32LE(inputBytes, 4)
      encoder.push(trailer)
      callback()
    }
  })
  return encoder
}
