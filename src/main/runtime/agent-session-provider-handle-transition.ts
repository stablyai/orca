import {
  agentSessionProviderHandleChainHead,
  appendAgentSessionProviderHandleLink,
  isAgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

export function recordAgentSessionProviderHandle(args: {
  record: AgentSessionRecord
  fence: number
  link: AgentSessionProviderHandleLink
  now: number
}): AgentSessionRecord {
  const { record } = args
  if (record.lease.runtimeFence !== args.fence) {
    throw new Error('agent_session_stale_fence')
  }
  if (args.link.handle.provider !== record.provider || args.link.mintedAtFence !== args.fence) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  if (record.lease.claimStatus !== 'live' && record.lease.handoffStage !== 'new-owner-proving') {
    throw new Error('agent_session_ownership_unknown')
  }
  const providerHandleChain = appendAgentSessionProviderHandleLink(
    record.providerHandleChain,
    args.link
  )
  const head = providerHandleChain.at(-1)
  if (!head) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  return {
    ...record,
    providerHandleChain,
    lease: {
      ...record.lease,
      ...(record.lease.claimStatus === 'live' ? { provenHandleLinkId: head.linkId } : {}),
      lastRenewedAt: args.now
    },
    updatedAt: args.now
  }
}

/**
 * Advance the live owner's Claude resume point in place. The head link this owner minted keeps
 * its id and provenance; only its leaf moves, so a long conversation does not grow the chain.
 */
export function reviseAgentSessionClaudeResumePoint(args: {
  record: AgentSessionRecord
  fence: number
  providerSessionId: string
  leafUuid: string
  now: number
}): AgentSessionRecord {
  const { record } = args
  if (record.lease.runtimeFence !== args.fence) {
    throw new Error('agent_session_stale_fence')
  }
  if (record.lease.claimStatus !== 'live') {
    throw new Error('agent_session_ownership_unknown')
  }
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (
    head?.handle.provider !== 'claude' ||
    head.handle.sessionId !== args.providerSessionId ||
    head.mintedAtFence !== args.fence
  ) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  if (head.handle.leafUuid === args.leafUuid) {
    return record
  }
  const providerHandleChain = [
    ...record.providerHandleChain.slice(0, -1),
    { ...head, handle: { ...head.handle, leafUuid: args.leafUuid }, observedAt: args.now }
  ]
  // The revised chain must still read back as the same persisted chain.
  if (!isAgentSessionProviderHandleChain(providerHandleChain)) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  return { ...record, providerHandleChain, updatedAt: args.now }
}
