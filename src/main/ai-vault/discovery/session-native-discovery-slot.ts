import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'

const nativeDiscoverySlots = new PrioritySemaphore(8)

export async function withNativeDiscoverySlot<T>(
  read: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release = await nativeDiscoverySlots.acquire(0, signal)
  try {
    throwIfAiVaultScanCancelled(signal)
    return await read()
  } finally {
    release()
  }
}
