import type { TranscriptReadStart } from '../../ai-vault/transcripts/session-transcript-consumers'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import type { SessionSearchStore } from './session-search-store'
import type { SessionSearchFileIdentity } from './session-search-file-cursor'

/** Due files need a full reread; failed reads track counts and mtime to bound retries. */
export type SessionSearchFileState = 'current' | 'due' | 'failed'

export type SessionSearchFileRow = {
  path: string
  byteOffset?: number | null
  prefixHash?: string | null
  agent?: string | null
  identity: SessionSearchFileIdentity
  mtimeMs: number
  sizeBytes: number | null
  state: SessionSearchFileState
  failCount: number
  failedMtimeMs: number | null
}

export type SessionSearchResumableCursor = { byteOffset: number; prefixHash: string }

export type SessionSearchStateCounts = {
  current: number
  due: number
  failed: number
  /** Session counts distinguish indexed content from files that have only been discovered. */
  sessionsByAgent: Record<string, number>
  messages: number
}

export type SessionSearchIndexStore = Pick<
  SessionSearchStore,
  | 'work'
  | 'candidates'
  | 'catalog'
  | 'indexedFile'
  | 'coversTranscript'
  | 'resumableCursor'
  | 'beginWrite'
  | 'writeCommitted'
  | 'reportWriteFailure'
  | 'fileRow'
  | 'setFileState'
  | 'stateCounts'
  | 'purgeOlderThan'
  | 'close'
  | 'retentionCutoff'
  | 'setRetentionCutoffMs'
> & {
  removeFile(path: string): boolean | Promise<boolean>
  readonly acceptingReads?: boolean
  readonly catalogPending?: boolean
  readonly catalogEpoch?: number
  fileRows(): Iterable<SessionSearchFileRow> | AsyncIterable<SessionSearchFileRow>
  beginUnpreparedWrite?(start: TranscriptReadStart): SessionSearchFileWrite | null
  prepareCoverage?(paths: readonly string[]): Promise<void>
  coverageKnown?(path: string): boolean
  prepare?(): Promise<void>
  flush?(): Promise<void>
}
