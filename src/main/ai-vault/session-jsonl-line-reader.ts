import { createReadStream } from 'node:fs'

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d

export const AI_VAULT_JSONL_MAX_RECORD_BYTES = 8 * 1024 * 1024

export type AiVaultJsonlReadResult = {
  consumedThrough: number
  trailingPartialLine: string | null
  trailingPartialOversized: boolean
  oversizedRecords: number
  bytesRead: number
}

function decodeLine(parts: Buffer[], byteLength: number): string {
  const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, byteLength)
  const end =
    byteLength > 0 && bytes[byteLength - 1] === CARRIAGE_RETURN_BYTE ? byteLength - 1 : byteLength
  return bytes.toString('utf8', 0, end)
}

export async function* iterateAiVaultJsonlLines(
  path: string,
  options: {
    start?: number
    maxRecordBytes?: number
    yieldTrailingPartial?: boolean
  } = {}
): AsyncGenerator<string, AiVaultJsonlReadResult> {
  const start = options.start ?? 0
  const maxRecordBytes = options.maxRecordBytes ?? AI_VAULT_JSONL_MAX_RECORD_BYTES
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new RangeError('JSONL start offset must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 0) {
    throw new RangeError('JSONL record limit must be a non-negative safe integer')
  }

  let bytesRead = 0
  let consumedThrough = start
  let lineParts: Buffer[] = []
  let lineBytes = 0
  let discardingLine = false
  let oversizedRecords = 0
  const stream = createReadStream(path, { start })

  for await (const rawChunk of stream as AsyncIterable<Buffer>) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const chunkOffset = start + bytesRead
    bytesRead += chunk.length
    let cursor = 0
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(NEWLINE_BYTE, cursor)
      const segmentEnd = newline === -1 ? chunk.length : newline
      const segmentLength = segmentEnd - cursor

      if (!discardingLine && lineBytes + segmentLength > maxRecordBytes) {
        lineParts = []
        lineBytes = 0
        discardingLine = true
      }
      if (!discardingLine && segmentLength > 0) {
        lineParts.push(chunk.subarray(cursor, segmentEnd))
        lineBytes += segmentLength
      }
      if (newline === -1) {
        break
      }

      consumedThrough = chunkOffset + newline + 1
      if (discardingLine) {
        oversizedRecords += 1
      } else {
        yield decodeLine(lineParts, lineBytes)
      }
      lineParts = []
      lineBytes = 0
      discardingLine = false
      cursor = newline + 1
    }
  }

  const trailingPartialLine =
    !discardingLine && lineBytes > 0 ? decodeLine(lineParts, lineBytes) : null
  if (options.yieldTrailingPartial !== false && trailingPartialLine !== null) {
    yield trailingPartialLine
  }
  return {
    consumedThrough,
    trailingPartialLine,
    trailingPartialOversized: discardingLine,
    oversizedRecords,
    bytesRead
  }
}

export async function consumeAiVaultJsonlLines(args: {
  path: string
  start?: number
  maxRecordBytes?: number
  onLine: (line: string) => void
}): Promise<AiVaultJsonlReadResult> {
  const iterator = iterateAiVaultJsonlLines(args.path, {
    start: args.start,
    maxRecordBytes: args.maxRecordBytes,
    yieldTrailingPartial: false
  })
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return next.value
    }
    args.onLine(next.value)
  }
}
