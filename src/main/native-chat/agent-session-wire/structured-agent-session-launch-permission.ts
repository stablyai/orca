import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import { continuingStructuredAgentSessionInput } from './structured-agent-session-handing-over'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentChatPermissionModes,
  savedChatPermissionMode,
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

/** A synchronous admission read for providers whose modes need no model-catalog evidence. */
export function structuredAgentSessionImmediatePermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents'>,
  record: AgentSessionRecord
): AgentChatPermissionChoice | null {
  const support = agentChatPermissionModes(record.provider)
  return support && deps.agents.definition(record.provider)
    ? savedChatPermissionMode(support, record.permissionMode)
    : null
}

/** Only the exact live, positively unwritten input pins its acquisition compiler to Auto. */
export function structuredAgentSessionInputCompilerPermission(
  journal: Parameters<typeof continuingStructuredAgentSessionInput>[0] | undefined,
  startedFor?: string
): 'auto' | undefined {
  return journal && startedFor && continuingStructuredAgentSessionInput(journal, startedFor)
    ? 'auto'
    : undefined
}

/** Read the live continuation at invocation, before ordinary asynchronous launch resolution. */
export function structuredAgentSessionAttachPermission(
  context: Pick<StructuredAgentSessionAttachContext, 'deps' | 'sessions'>,
  options: { startedFor?: string },
  lock: Pick<StructuredAgentSessionAttachLock, 'wait'>
): (record: AgentSessionRecord) => Promise<AgentChatPermissionChoice | undefined> {
  return async (record) =>
    structuredAgentSessionInputCompilerPermission(
      context.sessions.get(record.sessionId)?.journal,
      options.startedFor
    ) ??
    (await lock.wait(structuredAgentSessionLaunchPermission(context.deps, record))) ??
    undefined
}
