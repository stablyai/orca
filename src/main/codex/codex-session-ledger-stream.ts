import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * Streams an append-only JSONL ledger one record at a time.
 *
 * Why: the backfill audit holds one line per published session file and neither
 * ledger is ever compacted, so a large Codex history makes a `readFileSync` plus
 * whole-file `JSON.parse` a multi-megabyte block of the Electron main thread.
 * Reading chunk by chunk keeps the window responsive while the pass runs.
 */
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
      // Why: the audit is the heal work queue. Treating EACCES/EIO as empty
      // would write a completion marker that permanently skips every session.
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
    // Torn tails are quarantined by the writer's leading newline; skip them.
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
