import { isRelayDatabaseTransientError } from './database.js'

export type DatabaseStartupRetryPolicy = {
  attempts: number
  windowMs: number
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
  // Which failures this particular startup step may repeat. Not every caller can
  // repeat everything the request path calls transient: what the retry re-runs
  // decides that, so the call site owns it.
  isRetryable?: (error: unknown) => boolean
}

export type DatabaseStartupRetryObserver = {
  onRetry?: (event: { attempt: number; delayMs: number; error: unknown }) => void
  onRecovered?: (event: { attempts: number }) => void
  onGaveUp?: (event: { attempts: number; error: unknown; retryable: boolean }) => void
}

function retryDelayMs(policy: DatabaseStartupRetryPolicy, attempt: number): number {
  const backoffMs = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
  return backoffMs + Math.floor(Math.random() * (policy.jitterMs + 1))
}

// Startup work that a cold dependency - a proxy sidecar that just started, a
// database still accepting the fleet back - can fail once and serve a moment
// later. The wall-clock window, not the attempt count, is the real bound.
export async function retryTransientDatabaseStartup<T>(
  operation: () => Promise<T>,
  policy: DatabaseStartupRetryPolicy,
  observer: DatabaseStartupRetryObserver = {}
): Promise<T> {
  const retryDeadline = Date.now() + policy.windowMs
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await operation()
      if (attempt > 1) observer.onRecovered?.({ attempts: attempt })
      return result
    } catch (error) {
      const remainingMs = retryDeadline - Date.now()
      const retryable = (policy.isRetryable ?? isRelayDatabaseTransientError)(error)
      if (attempt === policy.attempts || remainingMs <= 0 || !retryable) {
        observer.onGaveUp?.({ attempts: attempt, error, retryable })
        throw error
      }
      const delayMs = Math.min(retryDelayMs(policy, attempt), remainingMs)
      observer.onRetry?.({ attempt, delayMs, error })
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
