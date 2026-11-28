import { createReadStream } from 'node:fs'

const LEDGER_READ_CHUNK_BYTES = 64 * 1024

/** Stream growing ledgers in 64 KiB chunks to avoid whole-file reads and per-line promise churn. */
export async function forEachCodexSessionLedgerRecord(
  filePath: string,
  onRecord: (record: Record<string, unknown>) => void,
  options: { throwOnReadFailure?: boolean } = {}
): Promise<void> {
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    highWaterMark: LEDGER_READ_CHUNK_BYTES
  })
  let remainder = ''
  try {
    for await (const chunk of stream) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      let start = 0
      while (start < text.length) {
        const newlineIndex = text.indexOf('\n', start)
        if (newlineIndex === -1) {
          remainder += text.slice(start)
          break
        }
        if (remainder.length > 0) {
          const line = remainder + text.slice(start, newlineIndex)
          remainder = ''
          emitLedgerLine(line, onRecord)
        } else if (newlineIndex > start) {
          emitLedgerLine(text.slice(start, newlineIndex), onRecord)
        }
        start = newlineIndex + 1
      }
    }
    if (remainder.length > 0) {
      emitLedgerLine(remainder, onRecord)
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

function emitLedgerLine(raw: string, onRecord: (record: Record<string, unknown>) => void): void {
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
