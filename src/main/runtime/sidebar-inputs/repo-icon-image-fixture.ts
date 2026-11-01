/** A PNG header the dimension reader accepts; the pixels are never decoded in these tests. */
export function pngHeader(width: number, height: number, padTo = 0): Uint8Array {
  const bytes = Buffer.alloc(Math.max(33, padTo))
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}
