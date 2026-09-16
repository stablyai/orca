import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { claudeProviderHandleLink } from '../../claude/claude-structured-owner-identity'
import { recordAgentSessionProviderHandle } from '../../runtime/agent-session-provider-handle-transition'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAcquireInput } from './structured-agent-session-adapter'

/** Proof checkpoints survive failures later in acquisition, before an owner can be published. */
export function claudeRewindAcquisitionProofs(input: {
  store: Pick<AgentSessionRecordStore, 'transitionHandoff'>
  record: AgentSessionRecord
  rewind: StructuredAgentSessionAcquireInput['rewind']
  now: () => number
}): Pick<StructuredAgentSessionAcquireInput, 'rewind' | 'rewindRecovery'> {
  const { record, store } = input
  const pending = record.rewind
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  if (
    record.provider !== 'claude' ||
    pending?.phase !== 'prepared' ||
    head?.provider !== 'claude'
  ) {
    return input.rewind ? { rewind: input.rewind } : {}
  }
  const checkpoint = async (leafUuid?: string): Promise<void> => {
    await store.transitionHandoff(record.sessionId, (current) => {
      if (
        current.lease.runtimeFence !== record.lease.runtimeFence ||
        current.rewind?.operationId !== pending.operationId ||
        current.rewind.callerKey !== pending.callerKey ||
        current.rewind.phase !== 'prepared'
      ) {
        throw new Error('agent_session_checkpoint_stale')
      }
      if (leafUuid === undefined) {
        return {
          ...current,
          rewind: { ...pending, phase: 'refused', reason: 'outcome-unknown', retained: [] }
        }
      }
      if (leafUuid !== input.rewind?.targetUuid) {
        throw new Error('agent_session_rewind:proof-mismatch')
      }
      const observedAt = input.now()
      return {
        ...recordAgentSessionProviderHandle({
          record: current,
          fence: record.lease.runtimeFence,
          link: claudeProviderHandleLink({
            sessionId: head.sessionId,
            leafUuid,
            resumed: true,
            fence: record.lease.runtimeFence,
            observedAt
          }),
          now: observedAt
        }),
        rewind: { ...pending, phase: 'provider-succeeded', hydrationVerified: true }
      }
    })
  }
  if (input.rewind) {
    return { rewind: { ...input.rewind, onProved: checkpoint } }
  }
  if (!head.leafUuid) {
    throw new Error('agent_session_rewind:invalid-target')
  }
  return { rewindRecovery: { leafUuid: head.leafUuid, onProved: () => checkpoint() } }
}
