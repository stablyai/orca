import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d

type JsonlReadResult = {
  consumedThrough: number
  trailingPartialLine: string | null
  bytesRead: number
}

// Byte-accurate JSONL fold: offsets count bytes rather than decoded UTF-8
// characters, so an incremental read resumes at an exact line boundary.
export async function consumeCompleteJsonlLines(args: {
  path: string
  start: number
  onLine: (line: string) => void
  onLineBytes?: (line: Buffer) => void
  shouldStop?: () => boolean
}): Promise<JsonlReadResult> {
  if (args.shouldStop?.()) {
    return { consumedThrough: args.start, trailingPartialLine: null, bytesRead: 0 }
  }
  let consumedThrough = args.start
  let bytesRead = 0
  // A piece list avoids O(record^2) copying when one record spans many chunks.
  let remainderParts: Buffer[] = []
  let remainderLength = 0
  let stopped = false

  const stream = openTranscriptReadStream(args.path, { start: args.start }, 'scan')
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytesRead += chunk.length
    if (!chunk.includes(NEWLINE_BYTE)) {
      remainderParts.push(chunk)
      remainderLength += chunk.length
      continue
    }
    const data = chunk
    const carriedLength = remainderLength
    let lineStart = 0
    let newlineIndex = data.indexOf(NEWLINE_BYTE, lineStart)
    while (newlineIndex !== -1) {
      let line = data.subarray(lineStart, newlineIndex)
      // Only the first line of a chunk can carry a prefix; resetting inside the
      // branch keeps the common per-line path allocation-free.
      if (remainderLength > 0) {
        line = Buffer.concat([...remainderParts, line], remainderLength + line.length)
        remainderParts = []
        remainderLength = 0
      }
      const lineEnd = line.at(-1) === CARRIAGE_RETURN_BYTE ? line.length - 1 : line.length
      if (args.onLineBytes) {
        args.onLineBytes(line.subarray(0, lineEnd))
      } else {
        args.onLine(line.toString('utf-8', 0, lineEnd))
      }
      lineStart = newlineIndex + 1
      if (args.shouldStop?.()) {
        stopped = true
        break
      }
      newlineIndex = data.indexOf(NEWLINE_BYTE, lineStart)
    }
    consumedThrough += carriedLength + lineStart
    if (stopped) {
      remainderParts = []
      remainderLength = 0
      break
    }
    if (lineStart < data.length) {
      // Copy the tail so retaining it does not pin the whole chunk buffer.
      remainderParts = [Buffer.from(data.subarray(lineStart))]
      remainderLength = data.length - lineStart
    }
  }

  return {
    consumedThrough,
    trailingPartialLine:
      remainderLength > 0 ? Buffer.concat(remainderParts, remainderLength).toString('utf-8') : null,
    bytesRead
  }
}
