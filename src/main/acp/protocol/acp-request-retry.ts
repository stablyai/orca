import { setTimeout as delay } from 'node:timers/promises'
import { temporaryAcpProviderAnswer } from '../transport/acp-errors'

/** A bounded retry, owned by the operation that can still use the answer. */
export async function retryAcpRequest<T>(
  request: () => Promise<T>,
  operation: { signal?: AbortSignal; assertCurrent: () => void },
  retryable: (error: unknown) => boolean = temporaryAcpProviderAnswer
): Promise<T> {
  const assertCurrent = () => {
    operation.signal?.throwIfAborted()
    operation.assertCurrent()
  }
  for (const backoffMs of [250, 500]) {
    assertCurrent()
    try {
      return await request()
    } catch (error) {
      if (!retryable(error)) {
        throw error
      }
    }
    await delay(backoffMs, undefined, { signal: operation.signal })
  }
  assertCurrent()
  return request()
}
