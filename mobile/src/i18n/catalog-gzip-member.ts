import { gunzipSync } from 'fflate'

let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c
    }
  }
  let crc = -1
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

// fflate already ships in the page for device-store values; a second inflater would cost the eager budget.
export function inflateCatalogGzip(
  input: Uint8Array,
  expectedBytes: number,
  maxBytes: number
): Uint8Array {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) {
    throw new Error('invalid catalog gzip output size')
  }
  if (input.length < 18) {
    throw new Error('invalid catalog gzip member')
  }
  const trailer = new DataView(input.buffer, input.byteOffset + input.length - 8, 8)
  if (trailer.getUint32(4, true) !== expectedBytes) {
    throw new Error('invalid catalog gzip member')
  }
  // One spare byte: output that fills it ran past the declared size; fflate drops anything beyond.
  const output = gunzipSync(input, { out: new Uint8Array(expectedBytes + 1) })
  if (output.length !== expectedBytes || crc32(output) !== trailer.getUint32(0, true)) {
    throw new Error('invalid catalog gzip member')
  }
  return output
}
