import { closeSync, openSync, writeSync } from 'fs'

// Why 16K code units: JS string slicing is code-unit based. This keeps each
// UTF-8 Buffer comfortably below 64KiB even for non-ASCII JSON content.
const JSON_WRITE_CHUNK_CODE_UNITS = 16_384

/**
 * Write `json` to `path` in small slices via a single file descriptor.
 *
 * Why not writeFileSync(path, json): Electron's bundled Node can abort the
 * process when encoding a large string to UTF-8 in one filesystem write. Each
 * slice is encoded to a small Buffer first, so fs.writeSync never receives a
 * large string and surrogate pairs stay intact.
 */
export function writeJsonInChunks(path: string, json: string): void {
  const fd = openSync(path, 'w')
  try {
    let index = 0
    while (index < json.length) {
      const end = getNextChunkEnd(json, index)
      writeBufferFully(fd, Buffer.from(json.slice(index, end), 'utf8'))
      index = end
    }
  } finally {
    closeSync(fd)
  }
}

function getNextChunkEnd(json: string, index: number): number {
  let end = Math.min(index + JSON_WRITE_CHUNK_CODE_UNITS, json.length)
  const lastUnit = json.charCodeAt(end - 1)
  if (end < json.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    end -= 1
  }
  return end
}

function writeBufferFully(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.byteLength) {
    const bytesWritten = writeSync(fd, buffer, offset, buffer.byteLength - offset)
    if (bytesWritten === 0) {
      throw new Error('Failed to write stats JSON chunk')
    }
    offset += bytesWritten
  }
}
