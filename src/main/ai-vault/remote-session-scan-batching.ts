import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

// Batching bounds concurrent remote round trips; the yield between batches keeps
// the process responsive, and the batch boundary is where cancellation lands.
export async function mapRemoteScanBatches<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
  signal?: AbortSignal
): Promise<U[]> {
  const results: U[] = []
  for (let index = 0; index < items.length; index += concurrency) {
    throwIfAiVaultScanCancelled(signal)
    results.push(...(await Promise.all(items.slice(index, index + concurrency).map(mapper))))
    await yieldToEventLoop()
  }
  // An abort can land while the last batch yields, and empty inputs never enter
  // the loop at all — observe it here so neither path returns as a success.
  throwIfAiVaultScanCancelled(signal)
  return results
}
