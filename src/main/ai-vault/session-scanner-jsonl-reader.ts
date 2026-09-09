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
    const data =
      remainderLength > 0
        ? Buffer.concat([...remainderParts, chunk], remainderLength + chunk.length)
        : chunk
    remainderParts = []
    remainderLength = 0
    let lineStart = 0
    let newlineIndex = data.indexOf(NEWLINE_BYTE, lineStart)
    while (newlineIndex !== -1) {
      let lineEnd = newlineIndex
      if (lineEnd > lineStart && data[lineEnd - 1] === CARRIAGE_RETURN_BYTE) {
        lineEnd--
      }
      if (args.onLineBytes) {
        args.onLineBytes(data.subarray(lineStart, lineEnd))
      } else {
        args.onLine(data.toString('utf-8', lineStart, lineEnd))
      }
      lineStart = newlineIndex + 1
      if (args.shouldStop?.()) {
        stopped = true
        break
      }
      newlineIndex = data.indexOf(NEWLINE_BYTE, lineStart)
    }
    consumedThrough += lineStart
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
