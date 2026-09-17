/**
 * Streams JSONL lines together with their exact byte offsets so an incremental
 * scan can resume at the end of the last complete line. Byte accounting is done
 * on raw buffers because `readline` hides how many bytes a line consumed, and a
 * CRLF transcript would otherwise drift one byte per line.
 */
import { createReadStream } from 'node:fs'

const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d

export type JsonlLineAtOffset = {
  line: string
  /** Absolute byte offset just past this line, terminator included. */
  endOffset: number
  /** False when the file ended before a newline; the line may still grow. */
  terminated: boolean
}

function decodeLine(pieces: Buffer[]): string {
  const raw = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces)
  const end = raw.at(-1) === CARRIAGE_RETURN ? raw.length - 1 : raw.length
  return raw.toString('utf-8', 0, end)
}

export async function* readJsonlLinesFromOffset(
  filePath: string,
  startOffset: number
): AsyncGenerator<JsonlLineAtOffset> {
  const stream = createReadStream(filePath, { start: startOffset })
  const pending: Buffer[] = []
  let pendingBytes = 0
  let endOffset = startOffset

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    let searchFrom = 0
    for (;;) {
      const lineFeedIndex = chunk.indexOf(LINE_FEED, searchFrom)
      if (lineFeedIndex === -1) {
        break
      }
      const segment = chunk.subarray(searchFrom, lineFeedIndex)
      pending.push(segment)
      pendingBytes += segment.length
      endOffset += pendingBytes + 1
      const line = decodeLine(pending)
      pending.length = 0
      pendingBytes = 0
      searchFrom = lineFeedIndex + 1
      yield { line, endOffset, terminated: true }
    }
    if (searchFrom < chunk.length) {
      const remainder = chunk.subarray(searchFrom)
      pending.push(remainder)
      pendingBytes += remainder.length
    }
  }

  if (pendingBytes > 0) {
    yield { line: decodeLine(pending), endOffset: endOffset + pendingBytes, terminated: false }
  }
}
