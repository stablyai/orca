import { createReadStream } from 'node:fs'

export const AI_VAULT_SESSION_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024

export type AiVaultTranscriptLine = {
  text: string
  byteOffset: number
  lineNumber: number
}

// Why: readline strips CR, so `${line}\n` under-counts CRLF by one byte per line.
export async function* iterateAiVaultTranscriptLines(
  filePath: string
): AsyncGenerator<AiVaultTranscriptLine> {
  const input = createReadStream(filePath)
  try {
    // Why: leftover stays a chunk list so concat is leftover+incoming, not a
    // loop-carried growing Buffer (quadratic-buffer-concat).
    let leftoverChunks: Buffer[] = []
    let leftoverFileStart = 0
    let consumed = 0
    let lineNumber = 0
    for await (const chunk of input) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      consumed += incoming.length
      const data =
        leftoverChunks.length === 0 ? incoming : Buffer.concat([...leftoverChunks, incoming])
      let start = 0
      for (let index = 0; index < data.length; index += 1) {
        const code = data.at(index)
        if (code !== 0x0a && code !== 0x0d) {
          continue
        }
        if (code === 0x0d && index + 1 === data.length) {
          break
        }
        const terminator = code === 0x0d && data.at(index + 1) === 0x0a ? 2 : 1
        lineNumber += 1
        yield {
          text: data.subarray(start, index).toString('utf8'),
          byteOffset: leftoverFileStart + start,
          lineNumber
        }
        index += terminator - 1
        start = index + 1
      }
      leftoverChunks = start === data.length ? [] : [data.subarray(start)]
      leftoverFileStart += start
      if (consumed >= AI_VAULT_SESSION_TRANSCRIPT_MAX_BYTES) {
        break
      }
    }
    const trailing = trailingTranscriptLine(leftoverChunks, leftoverFileStart, lineNumber)
    if (trailing) {
      yield trailing
    }
  } finally {
    input.destroy()
  }
}

function trailingTranscriptLine(
  leftoverChunks: readonly Buffer[],
  fileStart: number,
  lineNumber: number
): AiVaultTranscriptLine | null {
  if (leftoverChunks.length === 0) {
    return null
  }
  const leftover =
    leftoverChunks.length === 1 ? leftoverChunks.at(0) : Buffer.concat(leftoverChunks)
  if (!leftover || leftover.length === 0) {
    return null
  }
  const text = leftover.at(-1) === 0x0d ? leftover.subarray(0, -1) : leftover
  if (text.length === 0) {
    return null
  }
  return {
    text: text.toString('utf8'),
    byteOffset: fileStart,
    lineNumber: lineNumber + 1
  }
}
