/**
 * Pure helpers for reading diagnostics out of a subprocess (git/gh/glab)
 * rejection. Kept in a standalone module (not `runner.ts`) so lightweight
 * consumers — e.g. PR-refresh error classification — can import them without
 * pulling in the runner's heavy execution machinery, and so tests that mock
 * `./runner` still get the real implementations.
 */

/**
 * Extract stderr/stdout from an execFile rejection.
 *
 * Why: Node's execFile rejects with an Error that has `.stdout` and `.stderr`
 * fields populated separately from `.message`. Reading `err.message` alone is
 * unreliable — it can truncate stderr or omit it entirely depending on Node
 * version and maxBuffer behavior. We prefer the explicit fields and fall
 * back to `.message` only when neither is present.
 */
export function extractExecError(err: unknown): { stderr: string; stdout: string } {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown }
    const stderr =
      typeof e.stderr === 'string'
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString('utf-8')
          : ''
    const stdout =
      typeof e.stdout === 'string'
        ? e.stdout
        : Buffer.isBuffer(e.stdout)
          ? e.stdout.toString('utf-8')
          : ''
    if (stderr || stdout) {
      return { stderr, stdout }
    }
    if (typeof e.message === 'string') {
      return { stderr: e.message, stdout: '' }
    }
  }
  return { stderr: String(err), stdout: '' }
}

/**
 * Detect a Retry-After hint in gh stderr and return the suggested delay in ms,
 * or null when the response includes no Retry-After.
 *
 * Why: gh forwards response headers when verbose, and prints "Retry-After:
 * <seconds>" in error output for primary rate-limit 429s. When present, the
 * caller is better served by propagating the error so the UI can surface the
 * real wait time — retrying on our own 250ms cadence just earns another 429
 * and burns the retry budget. Also supports HTTP-date Retry-After values.
 */
export function parseRetryAfterMs(stderr: string): number | null {
  const raw = findRetryAfterHeaderValue(stderr)
  if (raw === null) {
    return null
  }
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  }
  const ts = Date.parse(raw)
  if (Number.isNaN(ts)) {
    return null
  }
  return Math.max(0, ts - Date.now())
}

function findRetryAfterHeaderValue(stderr: string): string | null {
  const headerIndex = indexOfAsciiIgnoreCase(stderr, 'retry-after:', 0)
  if (headerIndex === -1) {
    return null
  }
  let valueStart = headerIndex + 'retry-after:'.length
  while (valueStart < stderr.length) {
    const code = stderr.charCodeAt(valueStart)
    if (code !== 9 && code !== 32) {
      break
    }
    valueStart++
  }
  let valueEnd = valueStart
  while (valueEnd < stderr.length) {
    const code = stderr.charCodeAt(valueEnd)
    if (code === 10 || code === 13) {
      break
    }
    valueEnd++
  }
  const value = stderr.slice(valueStart, valueEnd).trim()
  return value.length > 0 ? value : null
}

function indexOfAsciiIgnoreCase(value: string, search: string, fromIndex: number): number {
  const lastStart = value.length - search.length
  for (let index = Math.max(0, fromIndex); index <= lastStart; index++) {
    let matches = true
    for (let offset = 0; offset < search.length; offset++) {
      const code = value.charCodeAt(index + offset)
      const normalizedCode = code >= 65 && code <= 90 ? code + 32 : code
      if (normalizedCode !== search.charCodeAt(offset)) {
        matches = false
        break
      }
    }
    if (matches) {
      return index
    }
  }
  return -1
}
