import { isAgentSessionFenceCurrent } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionLease } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'

export function refuseStructuredProviderSwitch(
  lease: AgentSessionLease,
  expectedFence: number | null
): AgentSessionWireRefusal | null {
  if (lease.unreconciled) {
    return {
      code: 'execution_owner_reconciling',
      message: 'This host has not yet adjudicated the session lease.'
    }
  }
  if (lease.runtimeKind === 'tui') {
    return {
      code: 'agent_session_conflict',
      message: 'The agent terminal owns this session.'
    }
  }
  if (lease.claimStatus === 'conflicted') {
    return { code: 'agent_session_conflict', message: 'The session claim is conflicted.' }
  }
  if (lease.handoffStage !== null && lease.handoffStage !== 'new-owner-proving') {
    return {
      code: 'agent_session_conflict',
      message: `The session is mid-handoff (${lease.handoffStage}).`
    }
  }
  if (expectedFence === null || !isAgentSessionFenceCurrent(lease, expectedFence)) {
    return {
      code: 'agent_session_checkpoint_stale',
      message: `Expected runtime fence ${expectedFence ?? 'none'}; the session is at ${lease.runtimeFence}.`,
      currentFence: lease.runtimeFence
    }
  }
  if (
    lease.claimStatus === 'live' ||
    lease.claimStatus === 'reserved' ||
    lease.claimStatus === 'released'
  ) {
    return null
  }
  return {
    code: 'agent_session_ownership_unknown',
    message: 'The session has no owner to replace.'
  }
}
