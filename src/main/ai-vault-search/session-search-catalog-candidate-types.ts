import type { SessionSearchContainerRemoval } from './session-search-container-transition'
import type { SessionSearchRemovalReceipt } from './session-search-observation-authority'
import type { SessionSearchSnapshotRow } from './worker/session-search-worker-protocol'
import type { SessionSearchWorkResult } from './session-search-work-queue'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type {
  SessionSearchPublicationCommand,
  SessionSearchPublicationResult
} from './session-search-catalog-publications'

export type SessionSearchCatalogCandidate = {
  candidate: SessionFileCandidate
  root: string
  group: string
  alias: string
  sqlite: boolean
  preference: number
  sourceOrder: number
  sourcePath?: string
}

export type SessionSearchCandidateCommand =
  | { kind: 'publication-step' }
  | {
      kind: 'admit'
      rows: { key: string; revision: number }[]
      recent: boolean
      recovering: boolean
      read?: { path: string; delivery?: { scope: string; path: string; revision: number } }
    }
  | { kind: 'put'; row: SessionSearchCatalogCandidate }
  | {
      kind: 'batch'
      rows: (SessionSearchCatalogCandidate & { force?: boolean; metadata?: boolean })[]
    }
  | { kind: 'contested'; rows: { group: string; path: string }[] }
  | { kind: 'remove'; path: string; agents?: string[] }
  | {
      kind: 'remove-page'
      rows: {
        path: string
        agents?: string[]
        observation?: SessionSearchRemovalReceipt
        containers?: SessionSearchContainerRemoval[]
      }[]
    }
  | { kind: 'unowned-page'; rows: { path: string; agent?: string | null }[] }
  | { kind: 'path'; path: string; agent?: string | null; read?: boolean }
  | { kind: 'group'; group: string; after?: string }
  | { kind: 'changes'; after?: string; root?: string; agent?: string }
  | { kind: 'rerank'; root: string; agent: string; order: [string, number][]; after?: string }
  | { kind: 'consumed'; key: string; revision: number }
  | SessionSearchPublicationCommand
  | { kind: 'require'; path: string; reason?: 'force' | 'metadata'; delivered?: boolean }
  | { kind: 'acknowledge'; path: string; agent: string; revision: string; metadataOnly?: boolean }
export type SessionSearchCandidateRow = SessionSearchCatalogCandidate & {
  key: string
  selected: boolean
  required: boolean
  protectedPath: boolean
  forced: boolean
  metadata: boolean
  revision: number
}
export type SessionSearchCandidateResult = SessionSearchPublicationResult & {
  rows: SessionSearchCandidateRow[]
  pending: number
  pendingPublications: number
  after?: string
  withdrawn?: SessionSearchSnapshotRow[]
  processed?: number
  contested?: string[]
  work?: SessionSearchWorkResult
  unowned?: string[]
  scopeCounts?: [string, number, number][]
}
