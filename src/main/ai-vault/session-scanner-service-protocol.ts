import type { AiVaultListResult, AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitle,
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type { ReadAiVaultFirstUserPromptArgs } from './session-first-user-prompt-read'
import type { SessionParseCachePersistenceOptions } from './session-parse-cache-persistence'
import type { AiVaultWorkerScanOptions } from './session-scanner-worker-protocol'

export const AI_VAULT_SERVICE_PROTOCOL_VERSION = 1

export type AiVaultServiceLane = 'cache' | 'interactive'
export type AiVaultServiceOperation = 'scan' | 'titles' | 'subagents' | 'firstPrompt'

export type AiVaultServiceSubagentRequest = {
  agent: 'claude' | 'omp'
  parentFilePath: string
}

export type AiVaultServiceInit = {
  type: 'init'
  protocol: typeof AI_VAULT_SERVICE_PROTOCOL_VERSION
  sessionParseCache: SessionParseCachePersistenceOptions | null
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

export type AiVaultServiceRequest = AiVaultServiceRequestBody & { id: number }

export type AiVaultServiceParentMessage =
  | AiVaultServiceInit
  | AiVaultServiceRequest
  | { type: 'cancel'; id: number }
  | { type: 'invalidate'; generation: number; paths: string[] }
  | { type: 'shutdown' }

export type AiVaultServiceResultValue =
  | { operation: 'scan'; value: { result: AiVaultListResult; durationMs: number } }
  | { operation: 'titles'; value: AiVaultSessionTitlesResult }
  | { operation: 'subagents'; value: AiVaultSubagentListResult }
  | { operation: 'firstPrompt'; value: { prompt: string | null } }

export type AiVaultServiceChildMessage =
  | {
      type: 'ready'
      protocol: typeof AI_VAULT_SERVICE_PROTOCOL_VERSION
      pid: number
    }
  | ({ type: 'result'; id: number } & AiVaultServiceResultValue)
  | { type: 'error'; id: number; message: string; retryable: boolean }
  | { type: 'invalidated'; generation: number }

export function aiVaultServiceLane(operation: AiVaultServiceOperation): AiVaultServiceLane {
  return operation === 'subagents' || operation === 'firstPrompt' ? 'interactive' : 'cache'
}

export function isAiVaultServiceRequest(value: unknown): value is AiVaultServiceRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Record<string, unknown>
  return (
    message.type === 'request' &&
    Number.isSafeInteger(message.id) &&
    (message.operation === 'scan' ||
      message.operation === 'titles' ||
      message.operation === 'subagents' ||
      message.operation === 'firstPrompt')
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
