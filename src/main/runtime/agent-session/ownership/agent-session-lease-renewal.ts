import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import { renewAgentSessionLease } from './agent-session-lease-transitions'
import {
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from '../../agent-session-store-state'

export type AgentSessionLeaseRenewal = {
  sessionId: string
  fence: number
  childProbe: AgentSessionOwnerProbe
  now: number
  leaseTtlMs?: number
}

export function renewAgentSessionLeases(
  state: AgentSessionStoreState,
  renewals: readonly AgentSessionLeaseRenewal[],
  defaultLeaseTtlMs: number
): AgentSessionRecord[] {
  return renewals.map((args) => {
    const record = requireWritableAgentSessionRecord(state, args.sessionId)
    const renewed = renewAgentSessionLease({
      record,
      fence: args.fence,
      childProbe: args.childProbe,
      now: args.now,
      leaseTtlMs: args.leaseTtlMs ?? defaultLeaseTtlMs
    })
    state.records.set(args.sessionId, renewed)
    return renewed
  })
}
