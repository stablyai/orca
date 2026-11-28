import type {
  AgentHookInstallStatus,
  AgentHookTarget
} from '../../../shared/agent-hook-listener/configuration/agent-hook-types'
import type { AgentHookConsentDecision } from '../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import type { AgentHookConsentOffer } from '../../../shared/agent-hook-listener/configuration/agent-hook-consent-offer'

export type AgentHookConsentApi = {
  /** Adopts hooks already present; asks only about an agent with no decision. */
  offer: (agent: string) => Promise<AgentHookConsentOffer>
  /** Granting installs now; declining removes hooks Orca had installed for those agents. */
  decide: (args: {
    agents: AgentHookTarget[]
    decision: AgentHookConsentDecision
  }) => Promise<AgentHookInstallStatus[]>
  statuses: () => Promise<AgentHookInstallStatus[]>
}
