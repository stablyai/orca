import { statfs } from 'node:fs/promises'
import type Database from '../../sqlite/sync-database'

export type JournalConversionStorage = {
  freeBytes: number
  totalBytes: number
  remainingBytes?: number
}

/** Space the volume gives this user, and with `estimate` the whole original's size as an upper bound. */
export async function measureJournalConversionStorage(
  filename: string,
  source: Database.Database,
  estimate: boolean
): Promise<JournalConversionStorage> {
  const storage = await statfs(filename)
  const free = Number(storage.bavail) * Number(storage.bsize)
  const total = Number(storage.blocks) * Number(storage.bsize)
  if (!estimate) {
    return { freeBytes: free, totalBytes: total }
  }
  const pages = Number(source.pragma('page_count', { simple: true }))
  const pageSize = Number(source.pragma('page_size', { simple: true }))
  return { freeBytes: free, totalBytes: total, remainingBytes: pages * pageSize }
}
