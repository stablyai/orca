import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot,
  agentSessionProviderHandlesEqual,
  appendAgentSessionProviderHandleLink,
  isAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import { agentSessionProviderHandleBelongsTo } from '../../shared/agent-session-provider-handle-encoding'
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
  if (
    !agentSessionProviderHandleBelongsTo(args.link.handle, record.provider) ||
    args.link.mintedAtFence !== args.fence
  ) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  if (record.lease.claimStatus !== 'live' && record.lease.handoffStage !== 'new-owner-proving') {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
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
 * Move the live owner's resume point in place: the head link this owner minted keeps its id and
 * provenance, and only the adapter-owned data its handle carries changes, so a long conversation
 * does not grow the chain. The adapter decides what that data means; this only refuses a handle
 * that names another conversation.
 */
export function reviseAgentSessionProviderResumePoint(args: {
  record: AgentSessionRecord
  fence: number
  handle: AgentSessionProviderHandle
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
    !head ||
    agentSessionProviderHandleRoot(head.handle) !== agentSessionProviderHandleRoot(args.handle) ||
    head.mintedAtFence !== args.fence
  ) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  if (agentSessionProviderHandlesEqual(head.handle, args.handle)) {
    return record
  }
  const providerHandleChain = [
    ...record.providerHandleChain.slice(0, -1),
    { ...head, handle: args.handle, observedAt: args.now }
  ]
  // The revised chain must still read back as the same persisted chain.
  if (!isAgentSessionProviderHandleChain(providerHandleChain)) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  return { ...record, providerHandleChain, updatedAt: args.now }
}
