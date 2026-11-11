import type { SessionSearchStore } from './storage/session-search-store'
import { wakeSessionSearchMetadataWrite } from './session-search-store-write'

function wakeFailedFile(store: SessionSearchStore, path: string): void {
  const previous = store.fileRow(path)
  if (previous?.state !== 'failed') {
    return
  }
  store.setFileState(path, 'current')
  const row = store.fileRow(path)
  if (row) {
    store.onSourceWake(previous, row)
  }
}

export function requireSessionSearchCandidateReason(
  store: SessionSearchStore,
  path: string,
  reason: 'force' | 'metadata'
): boolean {
  const selected = store.catalogCandidates
    .execute({ kind: 'path', path })
    .rows.some((row) => row.selected)
  if (selected) {
    if (
      reason === 'metadata' &&
      wakeSessionSearchMetadataWrite(store.connection, path, store.fileRow(path))
    ) {
      wakeFailedFile(store, path)
    }
    if (reason === 'force' && store.fileRow(path)?.state === 'failed') {
      wakeFailedFile(store, path)
    }
    store.catalogCandidates.execute({ kind: 'require', path, reason, delivered: true })
  }
  return selected
}
