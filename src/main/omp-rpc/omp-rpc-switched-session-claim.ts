// Moves an RPC session's execution claim onto the session a supported command
// switched the child to (XLR-018). Split out of the registry, which only
// orchestrates: the ordering here is the load-bearing part — the new claim is
// ensured BEFORE the old one is released, so no window exists in which this
// child holds neither and another pane can be offered either session.

import type { AgentSessionExecutionClaim } from '../../shared/agent-session-host-authority'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import {
  canonicalizeAgentSessionIdentity,
  type AgentSessionClaimSigner,
  type ProviderExecutionNamespace
} from '../runtime/agent-session-claim-identity'
import type { OmpRpcChatSession } from './omp-rpc-chat-session'

/** Rebinds `session.owned.owner` to a claim on `sessionId` and returns that
 *  claim for the caller to record. Throws the registry's own vocabulary —
 *  `agent_session_conflict` when the session already has a live owner (this
 *  child must be stopped rather than left as a second writer),
 *  `agent_session_ownership_unknown` when the claim itself cannot be made. */
export async function transferOmpRpcSwitchedSessionClaim(args: {
  session: OmpRpcChatSession
  sessionId: string
  /** Whether another pane already claims the session file being switched to. */
  claimedByAnotherPane: boolean
  ptyOwnerRegistry: ClaimedAgentPtyOwnerRegistry
  claimSigner: AgentSessionClaimSigner
  namespace: ProviderExecutionNamespace
  canonicalWorktreeId: string
}): Promise<AgentSessionExecutionClaim> {
  if (args.claimedByAnotherPane) {
    throw new Error('agent_session_conflict')
  }
  let claim: AgentSessionExecutionClaim
  try {
    claim = args.claimSigner.createClaim({
      namespace: args.namespace,
      identity: canonicalizeAgentSessionIdentity('omp', {
        key: 'session_id',
        id: args.sessionId
      }),
      canonicalWorktreeId: args.canonicalWorktreeId
    })
  } catch {
    throw new Error('agent_session_ownership_unknown')
  }
  let owner: Awaited<ReturnType<ClaimedAgentPtyOwnerRegistry['ensureRpc']>>['owner']
  try {
    const claimed = await args.ptyOwnerRegistry.ensureRpc({
      claim,
      spawn: () => args.session.owned.client
    })
    owner = claimed.owner
  } catch {
    throw new Error('agent_session_conflict')
  }
  if (!args.ptyOwnerRegistry.releaseRpc(args.session.owned.owner)) {
    args.ptyOwnerRegistry.releaseRpc(owner)
    throw new Error('agent_session_ownership_unknown')
  }
  args.session.owned.owner = owner
  return claim
}
