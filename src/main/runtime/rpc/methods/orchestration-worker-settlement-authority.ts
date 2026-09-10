import type { OrcaRuntimeService } from '../../orca-runtime'
import { exposeUtcTimestamp } from '../../orchestration/db/utc-timestamp'
import { readExactWorkerProviderObservation } from '../../orchestration/worker-provider-session'

export type WorkerSettlementActorAuthority =
  | { valid: true }
  | {
      valid: false
      code: 'sender_not_assignee_session' | 'sender_actor_unverifiable' | 'nested_agents_active'
      reason: string
    }

export function verifyWorkerSettlementActor(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  dispatch: { id: string; created_at: string; dispatched_at: string | null }
}): WorkerSettlementActorAuthority {
  const observedAfter = Date.parse(
    exposeUtcTimestamp(args.dispatch.dispatched_at ?? args.dispatch.created_at) ?? ''
  )
  const session = args.runtime.getExactWorkerProviderSession(
    args.terminalHandle,
    Number.isFinite(observedAfter) ? observedAfter : 0
  )
  const observation = readExactWorkerProviderObservation(session)
  const attestation = observation?.actorAttestation
  if (
    !session ||
    !observation ||
    !attestation ||
    !isWorkerSettlementEvent(attestation.provider, attestation.eventName) ||
    attestation.provider !== session.agent ||
    attestation.providerSessionId !== session.providerSession.id
  ) {
    return {
      valid: false,
      code: 'sender_actor_unverifiable',
      reason: `Dispatch ${args.dispatch.id} completion requires a live lead-provider tool attestation; coordinator review is required.`
    }
  }
  if (attestation.role !== 'lead') {
    return {
      valid: false,
      code: 'sender_not_assignee_session',
      reason: `Dispatch ${args.dispatch.id} completion came from native child actor ${attestation.providerActorId ?? 'unknown'}; only the assigned lead provider session may settle it.`
    }
  }
  const activeChildren = observation.subagents.filter((child) => child.state !== 'idle')
  if (activeChildren.length > 0) {
    return {
      valid: false,
      code: 'nested_agents_active',
      reason: `Dispatch ${args.dispatch.id} still owns ${activeChildren.length} active native child agent${activeChildren.length === 1 ? '' : 's'}.`
    }
  }
  return { valid: true }
}

function isWorkerSettlementEvent(provider: string, eventName: string): boolean {
  return provider === 'opencode' ? eventName === 'SessionBusy' : eventName === 'PreToolUse'
}
