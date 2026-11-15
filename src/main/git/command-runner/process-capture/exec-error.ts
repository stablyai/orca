// Keep diagnostics independent of runner imports and mocks.

/** Prefer stdout/stderr fields: Node may truncate or omit them from message. */
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

/** Recognizes spawn ENOENT; callers must separately rule out a missing cwd. */
export function isMissingCommandBinaryError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === 'object' &&
    'code' in err &&
    err.code === 'ENOENT' &&
    'syscall' in err &&
    typeof err.syscall === 'string' &&
    err.syscall.startsWith('spawn ')
  )
}

/** Parse Retry-After seconds or HTTP dates; callers can surface explicit server waits. */
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
