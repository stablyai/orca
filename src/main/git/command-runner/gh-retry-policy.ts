import { parseRetryAfterMs } from '../exec-error'
import { createAbortError } from './abort-error'

/** Retry 5xx/resets and 429 without Retry-After; propagate explicit waits and primary 403s. */
export function isTransientGhError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  if (
    s.includes('http 500') ||
    s.includes('http 502') ||
    s.includes('http 503') ||
    s.includes('http 504') ||
    s.includes('econnreset') ||
    s.includes('etimedout') ||
    s.includes('socket hang up')
  ) {
    return true
  }
  if (s.includes('http 429')) {
    return parseRetryAfterMs(stderr) === null
  }
  return false
}

// Two backoffs allow three attempts.
export const GH_RETRY_DELAYS_MS = [250, 1000] as const

// Cap untrusted Retry-After hints so IPC stays bounded.
export const GH_RETRY_AFTER_MAX_MS = 30_000
const DEFAULT_GH_EXEC_TIMEOUT_MS = 30_000

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError()
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => finish(createAbortError())
    function finish(error?: Error): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function defaultGhExecTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCA_GH_EXEC_TIMEOUT_MS
  if (!raw) {
    return DEFAULT_GH_EXEC_TIMEOUT_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GH_EXEC_TIMEOUT_MS
}
