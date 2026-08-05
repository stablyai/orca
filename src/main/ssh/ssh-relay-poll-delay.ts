import { createSshOperationAbortError } from './ssh-connection-utils'

/**
 * Abort-aware delay between remote relay polls. Rejects with the shared SSH abort error the moment
 * the signal fires, so a cancelled deploy never sits out the remaining interval.
 */
export function waitForRelayPollDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(createSshOperationAbortError())
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}
