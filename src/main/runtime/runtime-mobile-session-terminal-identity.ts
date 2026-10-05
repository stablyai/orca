import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentStatusEntry, AgentType } from '../../shared/agent-status-types'
import type { CompatibleAgentOwnerOptions } from '../../shared/agent-title-owner'
import type { RuntimeMobileSessionTerminalConversationFields } from '../../shared/runtime-mobile-session-tab-contracts'
import { conversationProviderSessionsEqual } from '../../shared/terminal-conversation-identity'
import type { StoredAgentConversationRead } from '../agent-hooks/server/server-types'
import type { RuntimeHookAgentRowLookup } from './runtime-mobile-agent-status-projection'
import type { RuntimeAgentRowSnapshot } from './runtime-worktree-agent-rows'
import {
  resolveTerminalConversationIdentity,
  type LegacyIdentityCandidate
} from './terminal-conversation-identity'

function hookRowCandidate(hookRow: RuntimeHookAgentRowLookup): LegacyIdentityCandidate | null {
  if (!hookRow.providerSession || hookRow.providerSessionReceivedAt === null) {
    return null
  }
  return {
    providerSession: hookRow.providerSession,
    sessionAgent: hookRow.providerSessionAgentType,
    ...(hookRow.providerSessionModel ? { model: hookRow.providerSessionModel } : {}),
    ...(hookRow.providerSessionModelSwitchCommand
      ? { modelSwitchCommand: hookRow.providerSessionModelSwitchCommand }
      : {}),
    capturedAt: hookRow.providerSessionReceivedAt,
    source: 'legacy-row'
  }
}

/** The address each host path already publishes in status, with the model from that same row. */
function legacyCandidate(args: {
  rendererStatus: AgentStatusEntry | null | undefined
  rendererProviderSession: AgentProviderSessionMetadata | undefined
  hookRow: RuntimeHookAgentRowLookup
  retained: RuntimeAgentRowSnapshot | null
}): LegacyIdentityCandidate | null {
  const { rendererStatus, hookRow } = args
  if (rendererStatus) {
    const chosen = args.rendererProviderSession
    if (!chosen) {
      return null
    }
    if (conversationProviderSessionsEqual(chosen, hookRow.providerSession)) {
      return hookRowCandidate(hookRow)
    }
    return {
      providerSession: chosen,
      sessionAgent: rendererStatus.agentType ?? null,
      ...(rendererStatus.model ? { model: rendererStatus.model } : {}),
      ...(rendererStatus.modelSwitchCommand
        ? { modelSwitchCommand: rendererStatus.modelSwitchCommand }
        : {}),
      capturedAt: rendererStatus.updatedAt,
      source: 'renderer'
    }
  }
  const retained = args.retained
  return (
    hookRowCandidate(hookRow) ??
    (retained?.providerSession
      ? {
          providerSession: retained.providerSession,
          sessionAgent: retained.payload.agentType ?? null,
          ...(retained.payload.model ? { model: retained.payload.model } : {}),
          ...(retained.payload.modelSwitchCommand
            ? { modelSwitchCommand: retained.payload.modelSwitchCommand }
            : {}),
          capturedAt: retained.updatedAt,
          source: 'legacy-row'
        }
      : null)
  )
}

/** A terminal tab's published conversation members: identity always, the offer only beside no status. */
export function projectRuntimeTerminalConversationFields(args: {
  stored: StoredAgentConversationRead | undefined
  rendererStatus: AgentStatusEntry | null | undefined
  rendererProviderSession: AgentProviderSessionMetadata | undefined
  hookRow: RuntimeHookAgentRowLookup
  retained: RuntimeAgentRowSnapshot | null
  ownerAgent: AgentType | null
  ownerOptions: CompatibleAgentOwnerOptions
  foregroundAgent: AgentType | null
  offeredByBuilder: boolean
  publishesAgentStatus: boolean
}): RuntimeMobileSessionTerminalConversationFields {
  const identity = resolveTerminalConversationIdentity({
    stored: args.stored,
    legacy: args.stored ? null : legacyCandidate(args),
    ownerAgent: args.ownerAgent,
    ownerOptions: args.ownerOptions,
    foregroundAgent: args.foregroundAgent
  })
  if (!identity) {
    return {}
  }
  return {
    conversationIdentity: identity,
    ...(args.offeredByBuilder && !args.publishesAgentStatus
      ? { conversationOfferedWithoutStatus: true as const }
      : {})
  }
}
