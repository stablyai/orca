import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentChatPermissionModes,
  chatModelSupportsAutoMode,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  type AgentChatPermissionChoice
} from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Use only the saved, folder-scoped catalog so startup never waits on a listing. */
async function listedAutoModeSupport(
  catalog: StructuredAgentSessionHostDeps['modelCatalog'],
  record: AgentSessionRecord
): Promise<boolean> {
  const listing = await catalog
    ?.read({
      agent: record.provider,
      sessionId: record.sessionId,
      savedOnly: true,
      inSessionWorkspace: true
    })
    .catch(() => null)
  return (
    listing !== null &&
    listing !== undefined &&
    listing.origin !== 'unknown' &&
    chatModelSupportsAutoMode(listing.models, record.options?.model)
  )
}

/** null for unregistered agents or agents without permission modes. */
export async function structuredAgentSessionLaunchPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents' | 'modelCatalog'>,
  record: AgentSessionRecord
): Promise<AgentChatPermissionChoice | null> {
  const support = agentChatPermissionModes(record.provider)
  if (!support || !deps.agents.definition(record.provider)) {
    return null
  }
  const intent = record.permissionMode
  const autoSupported =
    chatPermissionModeNeedsModelSupport(support, intent) &&
    (await listedAutoModeSupport(deps.modelCatalog, record))
  return effectiveChatPermissionMode(support, intent, autoSupported)
}
