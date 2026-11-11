import type { SessionSearchWorkCommand, SessionSearchWorkResult } from './session-search-work-queue'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import type { SessionSearchReadEvent } from './session-search-foreground-write'
import type {
  SessionSearchCatalogCommand,
  SessionSearchCatalogResult
} from './session-search-catalog'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type {
  TranscriptMessage,
  TranscriptReadOutcome,
  TranscriptSessionIdentity
} from '../ai-vault/transcripts/session-transcript-consumers'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../shared/ai-vault/search/ai-vault-search-types'
import type { SessionSearchHostScope } from './session-search-service'
import type {
  SessionSearchFileRow,
  SessionSearchFileState,
  SessionSearchStateCounts
} from './session-search-store'
import type { SessionContentHash } from './session-search-content-hash'

export type SessionSearchSnapshotRow = SessionSearchFileRow & {
  byteOffset: number | null
  prefixHash: string | null
  agent: string | null
  contentHash: SessionContentHash
}
export type SessionSearchCatalogEnvelope = {
  runtimeEpoch: number
  sourceId: string
  observationEpoch: number
  pageSequence: number
}
export type SearchWorkerCommand =
  | { op: 'open'; path: string; reader: boolean; cutoff: number | null; runtimeEpoch?: number }
  | {
      op: 'begin'
      metadataOnly?: boolean
      handle: number
      candidate: SessionFileCandidate
      mode: 'append' | 'replace'
      offset: number
      unprepared?: { allowCovered: boolean; canProvePrefix: boolean }
    }
  | {
      op: 'batch'
      handle: number
      rows: TranscriptMessage[]
      hash: SessionContentHash
      identity: TranscriptSessionIdentity | null
    }
  | {
      op: 'read-batch'
      handle: number
      events: SessionSearchReadEvent[]
      identity: TranscriptSessionIdentity | null
    }
  | { op: 'finish'; handle: number; outcome: TranscriptReadOutcome; hash: SessionContentHash }
  | { op: 'discard'; handle: number }
  | { op: 'state'; path: string; state: SessionSearchFileState; mtime?: number }
  | { op: 'remove'; path: string }
  | { op: 'purge'; cutoff: number | null }
  | { op: 'coverage'; paths: string[] }
  | { op: 'file-page'; after?: string }
  | { op: 'sync' }
  | {
      op: 'candidates'
      command: SessionSearchCandidateCommand
      catalogPage?: SessionSearchCatalogEnvelope
    }
  | { op: 'work'; command: SessionSearchWorkCommand; catalogPage?: SessionSearchCatalogEnvelope }
  | {
      op: 'catalog'
      command: SessionSearchCatalogCommand
      catalogPage?: SessionSearchCatalogEnvelope
    }
  | { op: 'query'; request: AiVaultSearchRequest; scope?: SessionSearchHostScope }
export type SearchWorkerRequest = { id: number; command: SearchWorkerCommand }
export type SearchWorkerResponse = {
  id: number
  trace?: unknown
  failure?: 'write'
  error?: string
  catalogPending?: boolean
  accepted?: boolean
  admission?: 'covered' | 'target' | 'lag' | 'gap' | 'rejected'
  prefixTarget?: number | null
  reset?: boolean
  coverage?: SessionSearchSnapshotRow[]
  filePage?: SessionSearchSnapshotRow[]
  deltas?: { path: string; row: SessionSearchSnapshotRow | null }[]
  counts?: SessionSearchStateCounts
  generation?: number
  candidates?: SessionSearchCandidateResult
  work?: SessionSearchWorkResult
  catalog?: SessionSearchCatalogResult
  result?: AiVaultSearchResponse
}
