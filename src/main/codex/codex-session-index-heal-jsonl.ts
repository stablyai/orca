import { closeSync, openSync, readSync } from 'node:fs'

export const MAX_CODEX_SESSION_INDEX_HEAL_JSONL_LINE_BYTES = 1024 * 1024
const HEAL_JSONL_READ_CHUNK_BYTES = 64 * 1024

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function parseJsonlRecord(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) {
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

export function* readCodexSessionIndexHealJsonlRecords(
  filePath: string
): Generator<Record<string, unknown>> {
  let descriptor: number
  try {
    descriptor = openSync(filePath, 'r')
  } catch (error) {
    if (isNotFoundError(error)) {
      return
    }
    throw error
  }

  const readBuffer = Buffer.allocUnsafe(HEAL_JSONL_READ_CHUNK_BYTES)
  let lineParts: Buffer[] = []
  let lineBytes = 0
  let skippingOversizedLine = false

  const resetLine = (): void => {
    lineParts = []
    lineBytes = 0
    skippingOversizedLine = false
  }
  const appendSegment = (start: number, end: number): void => {
    if (skippingOversizedLine || start === end) {
      return
    }
    const nextBytes = lineBytes + end - start
    if (nextBytes > MAX_CODEX_SESSION_INDEX_HEAL_JSONL_LINE_BYTES) {
      // Why: a corrupt line may span an arbitrarily large sparse file; discard until its newline.
      lineParts = []
      lineBytes = 0
      skippingOversizedLine = true
      return
    }
    lineParts.push(Buffer.from(readBuffer.subarray(start, end)))
    lineBytes = nextBytes
  }
  const takeRecord = (): Record<string, unknown> | null => {
    const raw =
      lineParts.length === 1
        ? lineParts[0].toString('utf8')
        : Buffer.concat(lineParts, lineBytes).toString('utf8')
    return parseJsonlRecord(raw)
  }

  try {
    while (true) {
      const bytesRead = readSync(descriptor, readBuffer, 0, readBuffer.length, null)
      if (bytesRead === 0) {
        break
      }
      let start = 0
      for (let index = 0; index < bytesRead; index += 1) {
        if (readBuffer[index] !== 0x0a) {
          continue
        }
        appendSegment(start, index)
        if (!skippingOversizedLine) {
          const record = takeRecord()
          if (record) {
            yield record
          }
        }
        resetLine()
        start = index + 1
      }
      appendSegment(start, bytesRead)
    }
    if (!skippingOversizedLine && lineBytes > 0) {
      const record = takeRecord()
      if (record) {
        yield record
      }
    }
  } finally {
    closeSync(descriptor)
  }
}
