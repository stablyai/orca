// Launch and restart require support; display retains saved intent until support is known.

import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentChatPermissionModes,
  chatModelSupportsAutoMode,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  savedChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Held support and preparation have separate owners; neither changes permission policy. */
export function structuredAgentSessionPermissionFromCatalog(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents'>,
  record: AgentSessionRecord,
  listing: AgentSessionModelCatalogResult | null | undefined
): AgentChatPermissionMode | null {
  const support = agentChatPermissionModes(record.provider)
  if (!support || !deps.agents.definition(record.provider)) {
    return null
  }
  const autoSupported =
    listing !== null &&
    listing !== undefined &&
    listing.origin !== 'unknown' &&
    chatModelSupportsAutoMode(listing.models, record.options?.model)
  return effectiveChatPermissionMode(support, record.permissionMode, autoSupported)
}

export function structuredAgentSessionDisplayPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents'>,
  record: AgentSessionRecord,
  listing: AgentSessionModelCatalogResult
): AgentChatPermissionMode | null {
  const support = agentChatPermissionModes(record.provider)
  return listing.origin === 'unknown' && support && deps.agents.definition(record.provider)
    ? savedChatPermissionMode(support, record.permissionMode)
    : structuredAgentSessionPermissionFromCatalog(deps, record, listing)
}

/** null for unregistered agents or agents without permission modes. */
export async function structuredAgentSessionLaunchPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents' | 'modelCatalog'>,
  record: AgentSessionRecord,
  deadline?: number
): Promise<AgentChatPermissionMode | null> {
  const support = agentChatPermissionModes(record.provider)
  if (!support || !deps.agents.definition(record.provider)) {
    return null
  }
  const intent = record.permissionMode
  const params = {
    agent: record.provider,
    sessionId: record.sessionId,
    savedOnly: true,
    inSessionWorkspace: true as const,
    deadline
  }
  const listing = chatPermissionModeNeedsModelSupport(support, intent)
    ? await (deps.modelCatalog?.prepareSaved?.(params) ?? deps.modelCatalog?.read(params))?.catch(
        () => null
      )
    : null
  return structuredAgentSessionPermissionFromCatalog(deps, record, listing)
}
