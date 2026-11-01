import { AI_VAULT_SCAN_CANCELLED_MESSAGE } from '../../shared/ai-vault-types'

export function throwIfAiVaultScanCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  throw createAiVaultScanCancelledError()
}

// RPC cannot abort in-flight work; cancellation releases its waiter while the request settles separately.
export function abandonRemoteSessionScanOnCancel<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise
  }
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      // Observe later failure even though the caller has already cancelled.
      void promise.catch(() => undefined)
      reject(createAiVaultScanCancelledError())
      return
    }
    const onAbort = (): void => reject(createAiVaultScanCancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function createAiVaultScanCancelledError(): Error {
  const error = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}
