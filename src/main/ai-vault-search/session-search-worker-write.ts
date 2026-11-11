import type { TranscriptSessionIdentity } from '../ai-vault/transcripts/session-transcript-consumers'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import type { SessionSearchStore } from './session-search-store'
import type { SearchWorkerCommand } from './session-search-worker-protocol'

export type SessionSearchPreparedWorkerWrite = {
  write: SessionSearchFileWrite
  identity: TranscriptSessionIdentity | null
}

export function beginSessionSearchWorkerWrite(
  store: SessionSearchStore,
  command: Extract<SearchWorkerCommand, { op: 'begin' }>
): SessionSearchPreparedWorkerWrite | null {
  let identity: TranscriptSessionIdentity | null = null
  const write = store.beginWrite(
    command.candidate,
    command.mode,
    command.offset,
    () => identity,
    false,
    undefined,
    command.metadataOnly
  )
  return write
    ? {
        write,
        get identity() {
          return identity
        },
        set identity(value) {
          identity = value
        }
      }
    : null
}
