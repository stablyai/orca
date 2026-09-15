import type { AiVaultListResult, AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitle,
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { SessionSearchScanRoots } from '../ai-vault-search/session-search-scan-roots'
import type { ReadAiVaultFirstUserPromptArgs } from './session-first-user-prompt-read'
import type { SessionParseCachePersistenceOptions } from './session-parse-cache-persistence'
import type { AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'

export const AI_VAULT_SERVICE_PROTOCOL_VERSION = 1

export type AiVaultServiceLane = 'cache' | 'interactive'
export type AiVaultServiceOperation =
  | 'scan'
  | 'titles'
  | 'subagents'
  | 'firstPrompt'
  | 'searchSessions'
  | 'searchStatus'
  | 'searchReconcile'
  | 'searchClear'

// Typed from the union so a new operation cannot be added without landing here,
// and held as strings so recognising one costs no assertion.
const AI_VAULT_SERVICE_OPERATIONS: ReadonlySet<string> = new Set<AiVaultServiceOperation>([
  'scan',
  'titles',
  'subagents',
  'firstPrompt',
  'searchSessions',
  'searchStatus',
  'searchReconcile',
  'searchClear'
])

export type AiVaultServiceSubagentRequest = {
  agent: 'claude' | 'omp'
  parentFilePath: string
}

/**
 * Everything the child needs to own this host's index.
 *
 * Initial roots also support standalone tests. Production asks the parent for
 * a fresh snapshot on each full sweep; the parent owns managed account homes.
 */
export type AiVaultSessionSearchInit = {
  databasePath: string
  settings: AiVaultSearchSettings
  roots: SessionSearchScanRoots
}

export type AiVaultServiceInit = {
  type: 'init'
  protocol: typeof AI_VAULT_SERVICE_PROTOCOL_VERSION
  sessionParseCache: SessionParseCachePersistenceOptions | null
  sessionSearch: AiVaultSessionSearchInit | null
}

export type AiVaultServiceRequestBody =
  | { type: 'request'; operation: 'scan'; options: AiVaultWorkerScanOptions }
  | {
      type: 'request'
      operation: 'titles'
      requests: AiVaultSessionTitleRequest[]
    }
  | {
      type: 'request'
      operation: 'subagents'
      request: AiVaultServiceSubagentRequest
    }
  | {
      type: 'request'
      operation: 'firstPrompt'
      request: ReadAiVaultFirstUserPromptArgs
    }
  | { type: 'request'; operation: 'searchSessions'; request: AiVaultSearchRequest }
  | { type: 'request'; operation: 'searchStatus' }
  | { type: 'request'; operation: 'searchReconcile' }
  | { type: 'request'; operation: 'searchClear' }

export type AiVaultServiceRequest = AiVaultServiceRequestBody & { id: number }

export type AiVaultServiceParentMessage =
  | AiVaultServiceInit
  | AiVaultServiceRequest
  | { type: 'cancel'; id: number }
  | { type: 'invalidate'; generation: number; paths: string[] }
  // Fire-and-forget: the child closes the live pair and constructs from this.
  | { type: 'sessionSearch'; init: AiVaultSessionSearchInit }
  | { type: 'sessionSearchRoots'; id: number; roots: SessionSearchScanRoots | null }
  | { type: 'shutdown' }

export type AiVaultServiceResultValue =
  | { operation: 'scan'; value: { result: AiVaultListResult; durationMs: number } }
  | { operation: 'titles'; value: AiVaultSessionTitlesResult }
  | { operation: 'subagents'; value: AiVaultSubagentListResult }
  | { operation: 'firstPrompt'; value: { prompt: string | null } }
  | { operation: 'searchSessions'; value: AiVaultSearchResponse }
  | { operation: 'searchStatus'; value: AiVaultSearchStatus }
  | { operation: 'searchReconcile'; value: null }
  | { operation: 'searchClear'; value: null }

export type AiVaultServiceChildMessage =
  | { type: 'sessionSearchRoots'; id: number }
  | {
      type: 'ready'
      protocol: typeof AI_VAULT_SERVICE_PROTOCOL_VERSION
      pid: number
    }
  | ({ type: 'result'; id: number } & AiVaultServiceResultValue)
  | { type: 'error'; id: number; message: string; retryable: boolean }
  | { type: 'invalidated'; generation: number }

/** Everything but the two bulk reads is interactive: a search must not queue behind a scan. */
export function aiVaultServiceLane(operation: AiVaultServiceOperation): AiVaultServiceLane {
  return operation === 'scan' || operation === 'titles' ? 'cache' : 'interactive'
}

export function isAiVaultServiceRequest(value: unknown): value is AiVaultServiceRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  return (
    'type' in value &&
    value.type === 'request' &&
    'id' in value &&
    Number.isSafeInteger(value.id) &&
    'operation' in value &&
    typeof value.operation === 'string' &&
    AI_VAULT_SERVICE_OPERATIONS.has(value.operation)
  )
}

export function isAiVaultServiceChildMessage(value: unknown): value is AiVaultServiceChildMessage {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Record<string, unknown>
  if (message.type === 'ready') {
    return message.protocol === AI_VAULT_SERVICE_PROTOCOL_VERSION && Number.isInteger(message.pid)
  }
  if (message.type === 'sessionSearchRoots') {
    return Number.isSafeInteger(message.id)
  }
  if (message.type === 'invalidated') {
    return Number.isSafeInteger(message.generation)
  }
  return (message.type === 'result' || message.type === 'error') && Number.isSafeInteger(message.id)
}

export function cacheServiceTitle(
  titleIndex: Map<string, AiVaultSessionTitle>,
  title: AiVaultSessionTitle,
  maxEntries = 4_096
): void {
  const key = `${title.agent}\0${title.sessionId}`
  titleIndex.delete(key)
  titleIndex.set(key, title)
  while (titleIndex.size > maxEntries) {
    const oldest = titleIndex.keys().next().value
    if (oldest === undefined) {
      break
    }
    titleIndex.delete(oldest)
  }
}
