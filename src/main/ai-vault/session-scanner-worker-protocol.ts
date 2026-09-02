import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type { AiVaultScanOptions } from './session-scanner-types'
import type { SessionParseCachePersistenceOptions } from './session-parse-cache-persistence'

export type AiVaultWorkerScanOptions = Omit<AiVaultScanOptions, 'signal'>

export type AiVaultWorkerData = {
  sessionParseCache: SessionParseCachePersistenceOptions | null
}

export type AiVaultWorkerRequest =
  | { id: number; kind: 'scan'; options: AiVaultWorkerScanOptions }
  | { id: number; kind: 'titles'; requests: AiVaultSessionTitleRequest[] }

export type AiVaultWorkerControl = { id: number; kind: 'cancel' }

export type AiVaultWorkerResponse =
  | {
      id: number
      ok: true
      kind: 'scan'
      value: { result: AiVaultListResult; durationMs: number }
    }
  | { id: number; ok: true; kind: 'titles'; value: AiVaultSessionTitlesResult }
  | { id: number; ok: false; error: string }
