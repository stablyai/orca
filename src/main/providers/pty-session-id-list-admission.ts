import {
  MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES,
  MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES,
  PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE
} from './pty-process-list-admission'
import type { IPtyProvider } from './types'

export async function listPtyProviderSessionIds(provider: IPtyProvider): Promise<string[]> {
  if (provider.listSessionIds) {
    return await provider.listSessionIds()
  }
  return (await provider.listProcesses()).map(({ id }) => id)
}

export async function listUniquePtyProviderSessionIds(
  providers: readonly IPtyProvider[]
): Promise<string[]> {
  const listings = await Promise.all(providers.map(listPtyProviderSessionIds))
  return Array.from(new Set(listings.flat()))
}

export class PtySessionIdListAdmission {
  private entries = 0
  private retainedBytes = 0
  private readonly seen = new Set<string>()

  admit(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('invalid_pty_session_id_list')
    }
    const nextEntries = this.entries + 1
    const nextBytes = this.retainedBytes + Buffer.byteLength(value, 'utf8')
    if (
      nextEntries > MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES ||
      nextBytes > MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES
    ) {
      throw new Error('pty_session_id_list_capacity')
    }
    this.entries = nextEntries
    this.retainedBytes = nextBytes
    if (this.seen.has(value)) {
      return false
    }
    this.seen.add(value)
    return true
  }
}

export async function collectPtySessionIdListings<T>(
  sources: Iterable<T>,
  load: (source: T) => Promise<readonly unknown[]>
): Promise<string[]> {
  const admission = new PtySessionIdListAdmission()
  const sessionIds: string[] = []
  let batch: T[] = []
  const loadBatch = async (): Promise<void> => {
    const listings = await Promise.all(batch.map(load))
    for (const listing of listings) {
      for (const value of listing) {
        if (admission.admit(value)) {
          sessionIds.push(value as string)
        }
      }
    }
    batch = []
  }
  for (const source of sources) {
    batch.push(source)
    if (batch.length === PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE) {
      await loadBatch()
    }
  }
  if (batch.length > 0) {
    await loadBatch()
  }
  return sessionIds
}
