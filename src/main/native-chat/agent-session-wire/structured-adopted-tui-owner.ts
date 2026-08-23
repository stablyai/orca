import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { StructuredTuiOwner } from './structured-agent-session-handoff-types'

export function registerAdoptedStructuredTuiOwner(input: {
  record: AgentSessionRecord
  owner: StructuredTuiOwner
  hostLabel?: string
  retain: () => void
  publish: (status: AgentSessionHandoffStatus) => void
}): void {
  if (input.record.lease.runtimeKind !== 'tui' || input.record.lease.claimStatus !== 'live') {
    throw new Error('agent_session_ownership_unknown')
  }
  input.retain()
  input.publish({
    owner: 'tui',
    direction: null,
    phase: 'idle',
    stage: null,
    operationId: null,
    terminal: input.owner.terminal,
    ...(input.hostLabel ? { hostLabel: input.hostLabel } : {})
  })
}
