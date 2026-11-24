// One predicate for the detail read and the published availability, so a read can never succeed
// where availability for the same session state would already be withdrawn.

import type { AgentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionCommandDetailTuple } from '../../../../shared/agent-session/background-tasks/agent-session-command-details'
import type { StructuredCommandDetailRecord } from '../observations/structured-agent-session-status-ownership'

/** The stored producer fence is still the owner, or that same acquisition was provably released
 *  and nothing newer has acquired or is handing off since. */
function providerAuthorityCurrent(
  conversation: Pick<AgentSessionConversationView, 'currentFence' | 'ownerObservation'>,
  fence: number
): boolean {
  if (conversation.currentFence === fence) {
    return true
  }
  const owner = conversation.ownerObservation
  return (
    conversation.currentFence > fence &&
    owner.claimStatus === 'released' &&
    owner.ownerProcess === null &&
    owner.reservedSpawnToken === null &&
    owner.handoffStage === null &&
    owner.deathEvidence?.ownerFence === fence
  )
}

/** The exact command for this tuple, or null: every check must hold, on this session's own child. */
export function eligibleStructuredCommandDetail(input: {
  conversation: Pick<
    AgentSessionConversationView,
    'currentFence' | 'ownerObservation' | 'provider'
  > | null
  membershipCurrent: boolean
  detail: StructuredCommandDetailRecord | null
  tuple: AgentSessionCommandDetailTuple
}): string | null {
  const { conversation, detail, tuple } = input
  if (!conversation || conversation.provider !== 'codex' || !input.membershipCurrent || !detail) {
    return null
  }
  const { record, slot } = detail
  if (
    !slot ||
    record.childWorkId !== tuple.childWorkId ||
    record.kind !== 'command' ||
    record.provenance.source !== 'structured-session' ||
    record.residency !== 'background' ||
    record.invocation.invocationId !== tuple.invocationId ||
    record.invocation.generation !== tuple.generation ||
    !providerAuthorityCurrent(conversation, slot.fence)
  ) {
    return null
  }
  return slot.display
}
