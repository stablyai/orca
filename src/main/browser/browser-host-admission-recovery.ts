import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../shared/remote-runtime-client-error-classification'
import { nextBrowserHostReconnectDelay } from './browser-host-lease-reconnect-delay'
import type { BrowserHostReconnectDelay } from './browser-host-lease-reconnect-delay'

type BrowserHostInitialAdmissionRetryOptions = {
  attach(timeoutMs: number): Promise<BrowserClientHostLeaseAuthority>
  browserHostClientId: string
  delay: BrowserHostReconnectDelay
  isClosed(): boolean
  retryDelayMs: number
  timeoutMs: number
}

export async function attachBrowserHostWithInitialAdmissionRetry(
  options: BrowserHostInitialAdmissionRetryOptions
): Promise<BrowserClientHostLeaseAuthority> {
  const deadline = Date.now() + options.timeoutMs
  let lastError: Error | null = null
  let attempt = 0
  while (!options.isClosed()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      break
    }
    try {
      return await options.attach(remaining)
    } catch (error) {
      lastError = asError(error)
      if (!isBrowserHostAdmissionCapacityError(lastError)) {
        throw lastError
      }
    }
    const beforeDelay = deadline - Date.now()
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
  }
  if (options.isClosed()) {
    throw new Error('Browser host lease is closed')
  }
  throw new RemoteRuntimeClientError(
    'runtime_timeout',
    lastError
      ? `Browser host lease attach capacity retry expired: ${lastError.message}`
      : 'Browser host lease attach capacity retry expired.'
  )
}

export function isBrowserHostAdmissionCapacityError(error: unknown): boolean {
  return toRemoteRuntimeClientErrorLike(error).code === 'runtime_busy'
}

export function isRecoverableBrowserHostLeaseError(error: unknown): boolean {
  const classified = toRemoteRuntimeClientErrorLike(error)
  return (
    isRecoverableRemoteRuntimeConnectionError(classified) ||
    isBrowserHostAdmissionCapacityError(classified)
  )
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
