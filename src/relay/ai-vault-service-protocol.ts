import type { AiVaultListResult } from '../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../shared/ai-vault-session-title'
import type { SshAiVaultRelayListParams } from '../shared/ssh-ai-vault-relay'
import type { RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'

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
      operation: 'list'
      params: SshAiVaultRelayListParams
    }
  | {
      type: 'request'
      id: number
      operation: 'titles'
      requests: AiVaultSessionTitleRequest[]
    }

export type RelayAiVaultServiceLane = 'cache' | 'interactive'
export type RelayAiVaultServiceOperation = RelayAiVaultServiceRequest['operation']

/** Title reads must not queue behind a full scan; they back interactive UI. */
export function relayAiVaultServiceLane(
  operation: RelayAiVaultServiceOperation
): RelayAiVaultServiceLane {
  return operation === 'titles' ? 'interactive' : 'cache'
}

export type RelayAiVaultServiceParentMessage =
  | RelayAiVaultServiceInit
  | RelayAiVaultServiceRequest
  | { type: 'cancel'; id: number }
  | { type: 'shutdown' }

export type RelayAiVaultServiceChildMessage =
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
    (message.operation === 'list' || message.operation === 'titles')
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
