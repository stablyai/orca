import type {
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding
} from '../../../../shared/agent-session-host-authority'
import { isRegisteredAgentSessionOwnerLive } from '../provider/liveness'
import { agentSessionOwners, reconcileAgentSessionOwnerListings } from './agent-session-owners'

/**
 * What a claimed create here would do for this claim, decided as its own pre-spawn step decides
 * and changing nothing: the execution owners' listings reconciled first (claims outlive this
 * controller), then the registry's one decision with the create's liveness proof. The owner it
 * would adopt or join; null for a fresh create. A refusal rejects as the create's would.
 */
export async function prepareAgentSessionOwner(
  claim: AgentSessionExecutionClaim
): Promise<AgentSessionOwnerBinding | null> {
  await reconcileAgentSessionOwnerListings()
  return await agentSessionOwners.prepare(claim, isRegisteredAgentSessionOwnerLive)
}
