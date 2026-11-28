import { createReadStream } from 'node:fs'

const LEDGER_READ_CHUNK_BYTES = 64 * 1024

export function bufferSliceContains(
  buf: Buffer,
  start: number,
  end: number,
  needle: Buffer
): boolean {
  const needleLen = needle.length
  if (needleLen === 0) {
    return true
  }
  const limit = end - needleLen
  if (limit < start) {
    return false
  }
  const firstByte = needle[0]
  for (let i = start; i <= limit; i += 1) {
    if (buf[i] !== firstByte) {
      continue
    }
    let j = 1
    while (j < needleLen && buf[i + j] === needle[j]) {
      j += 1
    }
    if (j === needleLen) {
      return true
    }
  }
  return false
}

/** Stream growing ledgers in 64 KiB chunks to avoid whole-file reads and per-line promise churn. */
export async function forEachCodexSessionLedgerRecord(
  filePath: string,
  onRecord: (record: Record<string, unknown>) => void,
  options: {
    throwOnReadFailure?: boolean
    shouldParseLine?: (raw: string) => boolean
    shouldParseBuffer?: (buf: Buffer, start: number, end: number) => boolean
    /** Optional zero-alloc buffer consumer; return true when handled to skip toString + JSON.parse. */
    onLineBuffer?: (buf: Buffer, start: number, end: number) => boolean
  } = {}
): Promise<void> {
  const { shouldParseLine, shouldParseBuffer, onLineBuffer } = options
  const stream = createReadStream(filePath, {
    highWaterMark: LEDGER_READ_CHUNK_BYTES
  })
  const remainderChunks: Buffer[] = []
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      let start = 0
      while (start < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, start)
        if (newlineIndex === -1) {
          remainderChunks.push(chunk.subarray(start))
          break
        }
        if (remainderChunks.length > 0) {
          if (newlineIndex > start) {
            remainderChunks.push(chunk.subarray(start, newlineIndex))
          }
          const lineBuf =
            remainderChunks.length === 1 ? remainderChunks[0] : Buffer.concat(remainderChunks)
          remainderChunks.length = 0
          emitLedgerLineBuffer(
            lineBuf,
            0,
            lineBuf.length,
            onRecord,
            shouldParseBuffer,
            shouldParseLine,
            onLineBuffer
          )
        } else if (newlineIndex > start) {
          emitLedgerLineBuffer(
            chunk,
            start,
            newlineIndex,
            onRecord,
            shouldParseBuffer,
            shouldParseLine,
            onLineBuffer
          )
        }
        start = newlineIndex + 1
      }
    }
    if (remainderChunks.length > 0) {
      const lineBuf =
        remainderChunks.length === 1 ? remainderChunks[0] : Buffer.concat(remainderChunks)
      emitLedgerLineBuffer(
        lineBuf,
        0,
        lineBuf.length,
        onRecord,
        shouldParseBuffer,
        shouldParseLine,
        onLineBuffer
      )
    }
  } catch (error) {
    if (options.throwOnReadFailure && !isNotFoundError(error)) {
      // Unreadable healing queues cannot count as empty and certify sessions as complete.
      throw error
    }
  } finally {
    stream.destroy()
  }
}

function emitLedgerLineBuffer(
  buf: Buffer,
  start: number,
  end: number,
  onRecord: (record: Record<string, unknown>) => void,
  shouldParseBuffer?: (buf: Buffer, start: number, end: number) => boolean,
  shouldParseLine?: (raw: string) => boolean,
  onLineBuffer?: (buf: Buffer, start: number, end: number) => boolean
): void {
  if (end <= start || (end - start === 1 && buf[start] === 0x0d)) {
    return
  }
  if (shouldParseBuffer && !shouldParseBuffer(buf, start, end)) {
    return
  }
  if (onLineBuffer && onLineBuffer(buf, start, end)) {
    return
  }
  const raw = buf.toString('utf-8', start, end)
  if (shouldParseLine && !shouldParseLine(raw)) {
    return
  }
  const record = parseLedgerRecord(raw)
  if (record) {
    onRecord(record)
  }
}

function parseLedgerRecord(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || (raw.length === 1 && raw.charCodeAt(0) === 13)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
