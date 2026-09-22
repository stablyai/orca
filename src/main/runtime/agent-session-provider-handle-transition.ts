import {
  appendAgentSessionProviderHandleLink,
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
