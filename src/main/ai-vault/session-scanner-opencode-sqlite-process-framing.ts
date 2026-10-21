import { SearchSubprocessLineAccumulator } from '../../shared/search-subprocess-lines'

export const OPENCODE_SQLITE_REQUEST_MAX_BYTES = 1024 * 1024
export const OPENCODE_SQLITE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024
export const OPENCODE_SQLITE_PROCESS_MAX_TIMEOUT_MS = 60_000

export function createOpenCodeSqliteLineDecoder(
  maxBytes: number,
  onLine: (line: string) => void
): (chunk: Buffer) => void {
  const lines = new SearchSubprocessLineAccumulator(maxBytes)
  return (chunk) => {
    if (!lines.push(chunk, onLine)) {
      throw new Error('OpenCode SQLite transport frame exceeds its byte limit.')
    }
  }
}

export function encodeOpenCodeSqliteFrame(value: unknown, maxBytes: number): string {
  const line = JSON.stringify(value)
  if (Buffer.byteLength(line) > maxBytes) {
    throw new Error('OpenCode SQLite transport frame exceeds its byte limit.')
  }
  return `${line}\n`
}
