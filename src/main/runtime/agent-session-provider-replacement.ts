import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import type { AgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import type {
  AgentSessionAccountHome,
  AgentSessionLaunchArgs,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { isAgentSessionLaunchArgs } from '../../shared/agent-session-record'
import { assertFence, withLease } from './agent-session-lease-transitions'

export type AgentSessionProviderReplacement = {
  record: AgentSessionRecord
  expectedFence: number
  provider: AgentSessionHandleProvider
  accountHome: AgentSessionAccountHome
  spawnToken: string
  claimKeyId: string
  handoffOperationId: string | null
  now: number
  leaseTtlMs: number
  launchArgs?: AgentSessionLaunchArgs
  model?: string
}

export type AgentSessionProviderReplacementResult = {
  record: AgentSessionRecord
  disposition: 'replaced' | 'retry-reservation'
}

function sameAccountHome(left: AgentSessionAccountHome, right: AgentSessionAccountHome): boolean {
  return left.variable === right.variable && left.path === right.path
}

function isRetryReservation(
  record: AgentSessionRecord,
  request: AgentSessionProviderReplacement
): boolean {
  return (
    record.provider === request.provider &&
    sameAccountHome(record.accountHome, request.accountHome) &&
    record.lease.claimStatus === 'reserved' &&
    record.lease.handoffStage === 'new-owner-proving' &&
    record.lease.handoffOperationId === request.handoffOperationId
  )
}

/** Same host replacing its own provider child. Not a steal of a live session. */
export function replaceAgentSessionProvider(
  request: AgentSessionProviderReplacement
): AgentSessionProviderReplacementResult {
  const { record } = request
  if (request.launchArgs && !isAgentSessionLaunchArgs(request.launchArgs)) {
    throw new Error('agent_session_launch_env_invalid')
  }
  assertFence(record.lease, request.expectedFence)
  if (record.lease.settlementRetryRequired) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (record.lease.claimStatus === 'conflicted') {
    throw new Error('agent_session_conflict')
  }
  if (isRetryReservation(record, request)) {
    return { record, disposition: 'retry-reservation' }
  }
  if (record.lease.handoffStage !== null && record.lease.handoffStage !== 'new-owner-proving') {
    throw new Error('agent_session_conflict')
  }
  if (
    record.lease.claimStatus === 'live' &&
    record.provider === request.provider &&
    sameAccountHome(record.accountHome, request.accountHome)
  ) {
    throw new Error('agent_session_operation_invalid')
  }
  if (
    record.lease.claimStatus !== 'live' &&
    record.lease.claimStatus !== 'reserved' &&
    record.lease.claimStatus !== 'released'
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  return {
    disposition: 'replaced',
    record: withLease(
      {
        ...record,
        provider: request.provider,
        accountHome: request.accountHome,
        providerHandleChain: [],
        launchArgs: request.launchArgs ? [...request.launchArgs] : undefined,
        options: request.model ? { model: request.model } : undefined,
        updatedAt: request.now
      },
      {
        ...record.lease,
        runtimeKind: 'native',
        runtimeFence: nextAgentSessionFence(record.lease),
        handoffStage: 'new-owner-proving',
        provenHandleLinkId: null,
        ownerProcess: null,
        reservedSpawnToken: request.spawnToken,
        processlessAt: null,
        leaseDeadlineAt: request.now + request.leaseTtlMs,
        lastRenewedAt: request.now,
        handoffOperationId: request.handoffOperationId,
        claimStatus: 'reserved',
        deathEvidence: null,
        settlementRetryRequired: undefined,
        settlementRetryId: undefined
      }
    )
  }
}
