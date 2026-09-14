// Why: fs.read() may return fewer bytes than requested before EOF. Fill each
// protocol chunk so strict clients reject corruption, not valid short reads.
// Shared with fs.readFileRange, where the same rule makes a short result mean
// EOF and nothing else.

export type StreamChunkReader = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>
}

export async function readFullStreamChunk(
  handle: StreamChunkReader,
  buffer: Buffer,
  length: number,
  offset: number
): Promise<number> {
  let totalRead = 0
  while (totalRead < length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      length - totalRead,
      offset + totalRead
    )
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }
  return totalRead
}
