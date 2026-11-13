import type { SessionSearchStore } from './session-search-store'
import type { SessionSearchFileIdentity } from './session-search-file-cursor'

/** Due files need a full reread; failed reads track counts and mtime to bound retries. */
export type SessionSearchFileState = 'current' | 'due' | 'failed'

export type SessionSearchFileRow = {
  path: string
  identity: SessionSearchFileIdentity
  mtimeMs: number
  sizeBytes: number | null
  /** Stat of the sidecar that supplied this row's messages; null when its last read saw none. */
  sidecarMtimeMs: number | null
  sidecarSizeBytes: number | null
  state: SessionSearchFileState
  failCount: number
  /** Stat the last failed read observed; this file's or its sidecar's stat moving ends the holdout early. */
  failedMtimeMs: number | null
  failedSidecarMtimeMs: number | null
  failedSidecarSizeBytes: number | null
  /** When the last failed read was recorded; a stat that never moves still retries at this clock. */
  failedAtMs: number | null
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
  | 'indexedFile'
  | 'coversTranscript'
  | 'resumableCursor'
  | 'beginWrite'
  | 'writeCommitted'
  | 'reportWriteFailure'
  | 'files'
  | 'setFileState'
  | 'stateCounts'
  | 'removeFile'
  | 'purgeOlderThan'
  | 'close'
  | 'retentionCutoff'
  | 'setRetentionCutoffMs'
> & {
  readonly acceptingReads?: boolean
  prepare?(): Promise<void>
  flush?(): Promise<void>
}
