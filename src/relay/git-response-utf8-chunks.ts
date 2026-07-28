export type Utf8StringChunk = {
  start: number
  end: number
  byteLength: number
}

function encodedCodePointSize(value: string, index: number): { bytes: number; codeUnits: number } {
  const code = value.charCodeAt(index)
  if (code <= 0x7f) {
    return { bytes: 1, codeUnits: 1 }
  }
  if (code <= 0x7ff) {
    return { bytes: 2, codeUnits: 1 }
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      return { bytes: 4, codeUnits: 2 }
    }
  }
  return { bytes: 3, codeUnits: 1 }
}

export function planUtf8StringChunks(value: string, maxChunkBytes: number): Utf8StringChunk[] {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 4) {
    throw new RangeError('UTF-8 chunk limit must be a safe integer of at least 4 bytes')
  }

  const chunks: Utf8StringChunk[] = []
  let chunkStart = 0
  let chunkBytes = 0
  let index = 0
  while (index < value.length) {
    const encoded = encodedCodePointSize(value, index)
    if (chunkBytes > 0 && chunkBytes + encoded.bytes > maxChunkBytes) {
      chunks.push({ start: chunkStart, end: index, byteLength: chunkBytes })
      chunkStart = index
      chunkBytes = 0
    }
    chunkBytes += encoded.bytes
    index += encoded.codeUnits
  }
  if (chunkBytes > 0) {
    chunks.push({ start: chunkStart, end: value.length, byteLength: chunkBytes })
  }
  return chunks
}

export function encodeUtf8StringChunk(value: string, chunk: Utf8StringChunk): Buffer {
  const encoded = Buffer.from(value.slice(chunk.start, chunk.end), 'utf8')
  if (encoded.length !== chunk.byteLength) {
    throw new Error('UTF-8 chunk plan did not match encoded byte length')
  }
  return encoded
}
