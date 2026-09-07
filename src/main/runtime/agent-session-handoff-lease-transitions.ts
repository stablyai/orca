import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  assertFence,
  evictAgentSessionOwner,
  reserveAgentSessionOwner,
  withLease
} from './agent-session-lease-transitions'

export function recoverDeadTuiOwnerForHandoff(args: {
  record: AgentSessionRecord
  expectedFence: number
  operationId: string
  probe: AgentSessionOwnerProbe
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (
    record.lease.runtimeKind !== 'tui' ||
    record.lease.handoffStage !== null ||
    record.lease.claimStatus !== 'live' ||
    record.lease.ownerProcess === null
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  const evicted = evictAgentSessionOwner(args)
  return withLease(evicted, {
    ...evicted.lease,
    handoffStage: 'old-owner-stopped',
    handoffOperationId: args.operationId
  })
}

export function stopAgentSessionOwnerForHandoff(args: {
  record: AgentSessionRecord
  expectedFence: number
  operationId: string
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (
    record.lease.handoffStage !== 'preparing' ||
    record.lease.handoffOperationId !== args.operationId ||
    record.lease.ownerProcess === null
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    runtimeFence: nextAgentSessionFence(record.lease),
    handoffStage: 'old-owner-stopped',
    ownerProcess: null,
    reservedSpawnToken: null,
    processlessAt: null,
    claimStatus: 'released',
    lastRenewedAt: args.now,
    deathEvidence: {
      kind: 'exit-observed',
      detail: 'observed process exit',
      observedAt: args.now
    }
  })
}

export function rollbackAgentSessionHandoffPreparation(args: {
  record: AgentSessionRecord
  expectedFence: number
  operationId: string
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (
    record.lease.handoffStage !== 'preparing' ||
    record.lease.handoffOperationId !== args.operationId ||
    record.lease.claimStatus !== 'live' ||
    record.lease.ownerProcess === null
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    handoffStage: null,
    handoffOperationId: null,
    lastRenewedAt: args.now
  })
}

export function stopRecoveringTuiOwnerForHandoff(args: {
  record: AgentSessionRecord
  expectedFence: number
  operationId: string
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (
    (record.lease.handoffStage !== 'recovering' &&
      record.lease.handoffStage !== 'manual-recovery') ||
    record.lease.runtimeKind !== 'tui' ||
    record.lease.handoffOperationId !== null ||
    record.lease.claimStatus !== 'live' ||
    record.lease.ownerProcess === null
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    runtimeFence: nextAgentSessionFence(record.lease),
    handoffStage: 'old-owner-stopped',
    handoffOperationId: args.operationId,
    ownerProcess: null,
    reservedSpawnToken: null,
    processlessAt: null,
    claimStatus: 'released',
    lastRenewedAt: args.now,
    deathEvidence: {
      kind: 'exit-observed',
      detail: 'recovery proved TUI process exit',
      observedAt: args.now
    }
  })
}

export function reserveAgentSessionHandoffOwner(args: {
  record: AgentSessionRecord
  expectedFence: number
  runtimeKind: AgentSessionOwnerRuntimeKind
  spawnToken: string
  operationId: string
  claimKeyId: string
  now: number
  leaseTtlMs: number
}): AgentSessionRecord {
  return reserveAgentSessionOwner({
    record: args.record,
    expectedFence: args.expectedFence,
    probe: { outcome: 'reservation-unused' },
    reservation: {
      runtimeKind: args.runtimeKind,
      spawnToken: args.spawnToken,
      claimKeyId: args.claimKeyId,
      handoffOperationId: args.operationId,
      leaseTtlMs: args.leaseTtlMs,
      now: args.now
    }
  }).record
}

export function abandonAgentSessionHandoffAttempt(args: {
  record: AgentSessionRecord
  expectedFence: number
  operationId: string
  recoverableRuntimeKind: AgentSessionOwnerRuntimeKind
  now: number
}): AgentSessionRecord {
  const { record } = args
  assertFence(record.lease, args.expectedFence)
  if (
    record.lease.handoffStage !== 'new-owner-proving' ||
    record.lease.handoffOperationId !== args.operationId
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  return withLease(record, {
    ...record.lease,
    runtimeKind: args.recoverableRuntimeKind,
    runtimeFence: nextAgentSessionFence(record.lease),
    handoffStage: 'old-owner-stopped',
    ownerProcess: null,
    reservedSpawnToken: null,
    processlessAt: null,
    claimStatus: 'released',
    lastRenewedAt: args.now,
    deathEvidence: {
      kind: 'exit-observed',
      detail: 'handoff launch attempt stopped',
      observedAt: args.now
    }
  })
}
