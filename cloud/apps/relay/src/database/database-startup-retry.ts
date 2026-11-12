import { isRelayDatabaseTransientError } from './database.js'

export type DatabaseStartupRetryPolicy = {
  attempts: number
  windowMs: number
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
  // Call site owns retry policy: repeated startup work may be unsafe even for request-transient errors.
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

// Cold proxies/databases can recover moments later; bound startup retries by wall-clock window, not attempt count.
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
