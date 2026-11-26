import type { AgentModelCatalogLiveListing } from '../../agent-model-catalog/agent-model-catalog-entry'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentSessionInstructionPolicy } from '../../../../shared/agent-session/agent-session-instruction-policy'

export type StructuredAgentSessionProviderOpenInput = {
  sessionId: string
  fence: number
  acquisitionGeneration: string
  signal: AbortSignal
}

export type StructuredAgentSessionProviderOpenResult = {
  instructionContext?: { account: string; digest: string; filesIncluded: boolean }
  instructionPolicy?: AgentSessionInstructionPolicy
  /** Actual provider creation, independent of a head already committed by rewind. */
  newConversation?: boolean
  link?: AgentSessionProviderHandleLink
  reportedOptions: AgentSessionOptionsResult['current']
  catalogListing?: AgentModelCatalogLiveListing
}

export type StructuredAgentSessionProviderOpen = (
  input: StructuredAgentSessionProviderOpenInput
) => Promise<StructuredAgentSessionProviderOpenResult>
