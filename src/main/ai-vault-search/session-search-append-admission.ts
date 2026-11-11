import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchIndexStore } from './storage/session-search-store-types'
import { fileIdentity } from './storage/session-search-file-cursor'

export function sessionSearchAppendAdmission(
  store: SessionSearchIndexStore,
  candidate: SessionFileCandidate,
  offset: number
): 'target' | 'lag' | 'gap' {
  const cursor = store.indexedFile(candidate.file.path, fileIdentity(candidate.file))
  if (cursor?.byteOffset === offset) {
    return 'target'
  }
  const recoverable = store.resumableCursor(candidate)
  return recoverable && recoverable.byteOffset < offset ? 'lag' : 'gap'
}
