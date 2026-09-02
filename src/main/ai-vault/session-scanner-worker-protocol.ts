import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type { AiVaultScanOptions } from './session-scanner-types'
import type { SessionParseCachePersistenceOptions } from './session-parse-cache-persistence'
import type { AiVaultSearchCoverage, AiVaultSearchResult } from '../../shared/ai-vault-search-types'
import type {
  AiVaultServiceSearchRequest,
  AiVaultSessionSearchInit
} from './session-scanner-service-protocol'

export type AiVaultWorkerScanOptions = Omit<AiVaultScanOptions, 'signal'>

export type AiVaultWorkerData = {
  sessionParseCache: SessionParseCachePersistenceOptions | null
  sessionSearch?: AiVaultSessionSearchInit | null
}

export type AiVaultWorkerRequest =
  | { id: number; kind: 'scan'; options: AiVaultWorkerScanOptions }
  | { id: number; kind: 'titles'; requests: AiVaultSessionTitleRequest[] }
  | { id: number; kind: 'search'; request: AiVaultServiceSearchRequest }
  | { id: number; kind: 'searchCoverage'; request: Pick<AiVaultServiceSearchRequest, 'roots'> }

export type AiVaultWorkerControl = { id: number; kind: 'cancel' }

export type AiVaultWorkerResponse =
  | {
      id: number
      ok: true
      kind: 'scan'
      value: { result: AiVaultListResult; durationMs: number }
    }
  | { id: number; ok: true; kind: 'titles'; value: AiVaultSessionTitlesResult }
  | { id: number; ok: true; kind: 'search'; value: AiVaultSearchResult }
  | { id: number; ok: true; kind: 'searchCoverage'; value: AiVaultSearchCoverage }
  | { id: number; ok: false; error: string }
