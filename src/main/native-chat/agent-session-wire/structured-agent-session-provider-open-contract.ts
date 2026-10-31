import type { AgentModelCatalogLiveListing } from '../agent-model-catalog/agent-model-catalog-entry'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'

export type StructuredAgentSessionProviderOpenInput = {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  signal: AbortSignal
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
