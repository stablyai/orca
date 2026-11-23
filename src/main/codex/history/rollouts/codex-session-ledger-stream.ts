import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/** Stream growing ledgers to avoid blocking the main thread with whole-file reads. */
export async function* streamCodexSessionLedgerRecords(
  filePath: string,
  options: { throwOnReadFailure?: boolean } = {}
): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  try {
    for await (const raw of lines) {
      const record = parseLedgerRecord(raw)
      if (record) {
        yield record
      }
    }
  } catch (error) {
    if (options.throwOnReadFailure && !isNotFoundError(error)) {
      // Unreadable healing queues cannot count as empty and certify sessions as complete.
      throw error
    }
  } finally {
    lines.close()
  }
}

function parseLedgerRecord(raw: string): Record<string, unknown> | null {
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

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
