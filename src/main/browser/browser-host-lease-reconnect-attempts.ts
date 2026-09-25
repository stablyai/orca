import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  type BrowserHostReconnectDelay,
  nextBrowserHostReconnectDelay
} from './browser-host-lease-reconnect-delay'

export async function reconnectBrowserHostLeaseUntil(options: {
  deadline: number
  delay: BrowserHostReconnectDelay
  retryDelayMs: number
  browserHostClientId: string
  timeoutMs: number
  isClosed(): boolean
  attach(timeoutMs: number): Promise<void>
  canReconnect(error: Error): boolean
}): Promise<void> {
  let lastError: Error | null = null
  let attempt = 0
  while (!options.isClosed()) {
    const beforeDelay = options.deadline - Date.now()
    if (beforeDelay <= 0) {
      break
    }
    await options.delay.wait(
      nextBrowserHostReconnectDelay({
        baseDelayMs: options.retryDelayMs,
        attempt,
        remainingMs: beforeDelay,
        browserHostClientId: options.browserHostClientId
      })
    )
    attempt += 1
    if (options.isClosed()) {
      return
    }
    const remaining = options.deadline - Date.now()
    if (remaining <= 0) {
      break
    }
    try {
      await options.attach(Math.min(options.timeoutMs, remaining))
      return
    } catch (error) {
      lastError = asError(error)
      if (!options.canReconnect(lastError)) {
        throw lastError
      }
    }
  }
  throw new RemoteRuntimeClientError(
    'runtime_timeout',
    lastError
      ? `Browser host lease reconnect grace expired: ${lastError.message}`
      : 'Browser host lease reconnect grace expired.'
  )
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
