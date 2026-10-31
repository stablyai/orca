import type { RpcContext } from '../core'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

import {
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../../shared/agent-session-wire-refusals'

import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import { listStructuredProviderSessionOwnership } from '../../../native-chat/agent-session-wire/structured-provider-session-ownership'
import {
  conversationKeyId,
  keysMayMatch,
  terminalConversationKey
} from '../../../native-chat/structured-conversation-key'
import { canonicalAgentSessionDigest } from '../../../../shared/agent-session-mutation-envelope'

export function recordWorkspace(host: StructuredAgentSessionHost, id: string) {
  const record = host.deps.store.getRecord(id)
  if (!record) {
    throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
  }
  return record.location.workspaceId
}

/** Registered History IDs include file-backed agents; account and host remain part of identity. */
export function switchConversationIdentity(
  identity: Pick<AgentSessionAttachParams, 'provider' | 'accountHome' | 'location'>,
  providerSessionId: string
) {
  const key = {
    ...terminalConversationKey(identity.provider, providerSessionId),
    home: identity.accountHome
  }
  return {
    key,
    commandKey: `conversation:${canonicalAgentSessionDigest({
      conversation: { ...key, id: conversationKeyId(key) },
      executionHostId: identity.location.executionHostId,
      wslDistro: identity.location.wslDistro
    })}`
  }
}

export function switchRetainedOwner(
  host: StructuredAgentSessionHost,
  identity: Pick<AgentSessionAttachParams, 'provider' | 'accountHome' | 'location'>,
  providerSessionId: string
): string | null {
  const { key } = switchConversationIdentity(identity, providerSessionId)
  return (
    listStructuredProviderSessionOwnership(host.deps.store.listConversations()).find((owner) => {
      const record = host.deps.store.getRecord(owner.sessionId)
      return (
        owner.role === 'head' &&
        keysMayMatch(owner.key, key) &&
        record &&
        record.location.executionHostId === identity.location.executionHostId &&
        record.location.wslDistro === identity.location.wslDistro
      )
    })?.sessionId ?? null
  )
}

export function resolveStructuredSwitchRetainedOwner(
  error: unknown,
  host: StructuredAgentSessionHost,
  identity: Parameters<typeof switchRetainedOwner>[1] | undefined,
  providerSessionId: string | null | undefined
): string {
  const owner =
    isAgentSessionRefusalError(error) &&
    (error.refusal.code === 'agent_session_conflict' ||
      error.refusal.code === 'agent_session_ownership_unknown') &&
    identity &&
    providerSessionId &&
    switchRetainedOwner(host, identity, providerSessionId)
  if (
    !owner ||
    !isAgentSessionRefusalError(error) ||
    error.refusal.details?.owner?.sessionId !== owner
  ) {
    throw error
  }
  return owner
}

/** Translate only an unconfirmed exact terminal capture into the existing ownership refusal. */
export function captureStructuredSwitchTerminalSource(
  runtime: RpcContext['runtime'],
  host: StructuredAgentSessionHost,
  sessionId: string,
  direction: 'chat' | 'terminal',
  ...source: Parameters<RpcContext['runtime']['captureTerminalSwitchClose']>
) {
  try {
    return runtime.captureTerminalSwitchClose(...source)
  } catch {
    host.deps.logger.warn('switch source owner was not confirmed', {
      scope: 'session-switch',
      sessionId,
      direction,
      source: 'terminal',
      exactIncarnation: false
    })
    throw agentSessionRefusalError('agent_session_ownership_unknown', {
      reason: 'ownerUnproven'
    })
  }
}
