import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentModelCatalogLiveListing } from '../../agent-model-catalog/agent-model-catalog-entry'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'

export type StructuredAgentSessionProviderOpenInput = {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  signal: AbortSignal
  /** The chat's saved permission pick now, which may be newer than the one this child launched with. */
  permissionMode?: () => AgentChatPermissionChoice | null
}

export type StructuredAgentSessionProviderOpenResult = {
  /** Actual provider creation, independent of a head already committed by rewind. */
  newConversation?: boolean
  link?: AgentSessionProviderHandleLink
  reportedOptions: AgentSessionOptionsResult['current']
  catalogListing?: AgentModelCatalogLiveListing
}

export type StructuredAgentSessionProviderOpen = (
  input: StructuredAgentSessionProviderOpenInput
) => Promise<StructuredAgentSessionProviderOpenResult>
