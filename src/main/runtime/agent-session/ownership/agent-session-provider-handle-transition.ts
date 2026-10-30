import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandlesEqual,
  appendAgentSessionProviderHandleLink,
  isAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from '../../../../shared/agent-session-provider-handle'
import {
  agentSessionProviderHandleBelongsTo,
  agentSessionProviderHandleRoot
} from '../../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'

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

/** Revise the live head in place, preserving link id/provenance and bounding chain growth.
 * The adapter owns handle data; reject changes naming another conversation. */
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
  // Updated handles must retain the persisted chain contract.
  if (!isAgentSessionProviderHandleChain(providerHandleChain)) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  return { ...record, providerHandleChain, updatedAt: args.now }
}
