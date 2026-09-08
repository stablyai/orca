import type { AiVaultListResult } from '../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../shared/ai-vault-session-title'
import type { SshAiVaultRelayListParams } from '../shared/ssh-ai-vault-relay'
import type { RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import {
  SESSION_SEARCH_OPERATIONS,
  type SessionSearchOperation
} from '../shared/ai-vault-search-contract'

export const RELAY_AI_VAULT_SERVICE_PROTOCOL = 1

export type RelayAiVaultServiceInit = {
  type: 'init'
  protocol: typeof RELAY_AI_VAULT_SERVICE_PROTOCOL
  remoteHome: string
  hostPlatform: RemoteHostPlatform
}

export type RelayAiVaultServiceRequest =
  | {
      type: 'request'
      id: number
      operation: 'search'
      action: SessionSearchOperation
      params: unknown
    }
  | {
      type: 'request'
      id: number
      operation: 'list'
      params: SshAiVaultRelayListParams
    }
  | {
      type: 'request'
      id: number
      operation: 'titles'
      requests: AiVaultSessionTitleRequest[]
    }

export type RelayAiVaultServiceLane = 'cache' | 'interactive' | 'search'

/**
 * A lane is the unit of serialization, so it has to match where the work is
 * actually serialized: `list` is a full history scan, and every search operation
 * contends for the one chain `RelaySessionSearchOwner` runs them on. Splitting
 * `status`/`configure` onto their own lane would only move the wait from a queue
 * that holds them unsent into the owner's lock, where their deadline is already
 * running and a sidecar fault can no longer requeue them.
 */
export function relayAiVaultServiceLane(
  request: RelayAiVaultServiceRequest
): RelayAiVaultServiceLane {
  if (request.operation === 'list') {
    return 'cache'
  }
  return request.operation === 'search' ? 'search' : 'interactive'
}

export type RelayAiVaultServiceParentMessage =
  | RelayAiVaultServiceInit
  | RelayAiVaultServiceRequest
  | { type: 'cancel'; id: number }
  | { type: 'shutdown' }

export type RelayAiVaultServiceChildMessage =
  | { type: 'result'; id: number; operation: 'search'; value: unknown }
  | {
      type: 'ready'
      protocol: typeof RELAY_AI_VAULT_SERVICE_PROTOCOL
      pid: number
    }
  | { type: 'result'; id: number; operation: 'list'; value: AiVaultListResult }
  | {
      type: 'result'
      id: number
      operation: 'titles'
      value: AiVaultSessionTitlesResult
    }
  | { type: 'error'; id: number; message: string }

export function isRelayAiVaultServiceRequest(value: unknown): value is RelayAiVaultServiceRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Record<string, unknown>
  return (
    message.type === 'request' &&
    Number.isSafeInteger(message.id) &&
    (message.operation === 'list' ||
      message.operation === 'titles' ||
      (message.operation === 'search' &&
        SESSION_SEARCH_OPERATIONS.includes(message.action as SessionSearchOperation)))
  )
}

export function isRelayAiVaultServiceChildMessage(
  value: unknown
): value is RelayAiVaultServiceChildMessage {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Record<string, unknown>
  if (message.type === 'ready') {
    return message.protocol === RELAY_AI_VAULT_SERVICE_PROTOCOL && Number.isSafeInteger(message.pid)
  }
  return (message.type === 'result' || message.type === 'error') && Number.isSafeInteger(message.id)
}
