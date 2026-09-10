import { agentSessionForkAnchor } from '../../shared/agent-session-fork'
import { proveAgentSessionOwner } from './agent-session-lease-transitions'

/** Called inside the store transaction: an unproved fork never owns its parent's handle. */
export function proveAgentSessionForkOwner(input: Parameters<typeof proveAgentSessionOwner>[0]) {
  const fork = input.record.fork
  if (input.link.origin !== 'forked') {
    if (fork && (fork.phase === 'prepared' || fork.phase === 'attempted')) {
      throw new Error('agent_session_provider_handle_invalid')
    }
    return proveAgentSessionOwner(input)
  }
  if (fork?.phase !== 'attempted' || input.record.providerHandleChain.length !== 0) {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const proved = proveAgentSessionOwner({
    ...input,
    record: {
      ...input.record,
      providerHandleChain: [
        agentSessionForkAnchor(fork.source, input.fence, input.record.createdAt)
      ]
    }
  })
  return { ...proved, fork: { ...fork, phase: 'provider-succeeded' as const } }
}
