import {
  openTranscriptReadStream,
  readTranscriptSlice
} from '../native-chat/wsl-transcript-fs-access'

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d

// A resume offset not following a newline indicates a rewrite, so callers reparse cold.
export async function endsWithNewlineAt(path: string, offset: number): Promise<boolean> {
  const slice = await readTranscriptSlice(path, offset - 1, 1, 'scan')
  return slice.length === 1 && slice[0] === NEWLINE_BYTE
}

type JsonlReadResult = {
  consumedThrough: number
  trailingPartialLine: string | null
  bytesRead: number
}

export async function consumeCompleteJsonlLines(args: {
  path: string
  start: number
  onLine: (line: string) => void
}): Promise<JsonlReadResult> {
  // Offsets remain byte-accurate even when records contain multi-byte UTF-8.
  let consumedThrough = args.start
  let bytesRead = 0
  // Piecewise buffering prevents an oversized record from becoming O(record^2).
  let remainderParts: Buffer[] = []
  let remainderLength = 0

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
      args.onLine(data.toString('utf-8', lineStart, lineEnd))
      lineStart = newlineIndex + 1
      newlineIndex = data.indexOf(NEWLINE_BYTE, lineStart)
    }
    consumedThrough += lineStart
    if (lineStart < data.length) {
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
