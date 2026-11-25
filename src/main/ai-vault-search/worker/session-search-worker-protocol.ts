import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type {
  TranscriptMessage,
  TranscriptReadOutcome,
  TranscriptSessionIdentity
} from '../../ai-vault/transcripts/session-transcript-consumers'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../../shared/ai-vault/search/ai-vault-search-types'
import type { SessionSearchHostScope } from '../session-search-service'
import type {
  SessionSearchFileRow,
  SessionSearchFileState,
  SessionSearchStateCounts
} from '../storage/session-search-store-types'
import type { SessionContentHash } from '../storage/session-search-content-hash'

export type SessionSearchSnapshotRow = SessionSearchFileRow & {
  byteOffset: number | null
  prefixHash: string | null
  agent: string | null
  contentHash: SessionContentHash
}
export type SearchWorkerCommand =
  | { op: 'open'; path: string; reader: boolean; cutoff: number | null }
  | {
      op: 'begin'
      handle: number
      candidate: SessionFileCandidate
      mode: 'append' | 'replace'
      offset: number
    }
  | {
      op: 'batch'
      handle: number
      rows: TranscriptMessage[]
      hash: SessionContentHash
      identity: TranscriptSessionIdentity | null
    }
  | { op: 'finish'; handle: number; outcome: TranscriptReadOutcome; hash: SessionContentHash }
  | { op: 'discard'; handle: number }
  | { op: 'state'; path: string; state: SessionSearchFileState; mtime?: number }
  | { op: 'remove'; path: string }
  | { op: 'purge'; cutoff: number | null }
  | { op: 'sync' }
  | { op: 'query'; request: AiVaultSearchRequest; scope?: SessionSearchHostScope }
export type SearchWorkerRequest = { id: number; command: SearchWorkerCommand }
export type SearchWorkerResponse = {
  id: number
  trace?: unknown
  failure?: 'write'
  error?: string
  accepted?: boolean
  snapshot?: SessionSearchSnapshotRow[]
  deltas?: { path: string; row: SessionSearchSnapshotRow | null }[]
  counts?: SessionSearchStateCounts
  generation?: number
  result?: AiVaultSearchResponse
}
