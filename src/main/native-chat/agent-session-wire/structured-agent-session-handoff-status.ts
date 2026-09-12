import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffStatus
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

export function structuredTuiStatus(
  owner: StructuredTuiOwner | undefined,
  transport: StructuredAgentSessionHandoffTransport | undefined
): 'idle' | 'busy' {
  return owner ? (transport?.tuiStatus(owner) ?? 'busy') : 'busy'
}

export function idleStructuredHandoffStatus(record: AgentSessionRecord): AgentSessionHandoffStatus {
  if (
    record.lease.handoffStage === 'old-owner-stopped' &&
    record.lease.claimStatus === 'released' &&
    record.lease.handoffOperationId
  ) {
    return persistedFailedStructuredHandoffStatus(record)
  }
  if (record.lease.handoffStage === 'manual-recovery') {
    const canRetryProof = structuredTuiRecoveryProofIsAdmissible(record)
    return {
      owner: 'none',
      direction: record.lease.runtimeKind === 'tui' ? 'to-tui' : 'to-native',
      phase: 'failed',
      stage: 'manual-recovery',
      operationId: record.lease.handoffOperationId,
      error: {
        message: "Couldn't verify which runtime owns this session — manual recovery is required",
        recoverableOwner: 'none',
        ...(canRetryProof ? { canRetryProof: true } : {})
      }
    }
  }
  if (record.lease.handoffStage) {
    const direction =
      record.lease.handoffStage === 'preparing'
        ? record.lease.runtimeKind === 'native'
          ? 'to-tui'
          : 'to-native'
        : record.lease.runtimeKind === 'tui'
          ? 'to-tui'
          : 'to-native'
    return {
      owner:
        record.lease.claimStatus === 'live' && record.lease.ownerProcess
          ? record.lease.runtimeKind
          : 'none',
      direction,
      phase: 'switching',
      stage: record.lease.handoffStage,
      operationId: record.lease.handoffOperationId
    }
  }
  return {
    owner: record.lease.claimStatus === 'live' ? record.lease.runtimeKind : 'none',
    direction: null,
    phase: 'idle',
    stage: record.lease.handoffStage,
    operationId: record.lease.handoffOperationId
  }
}

function persistedFailedStructuredHandoffStatus(
  record: AgentSessionRecord
): AgentSessionHandoffStatus {
  const recoverableOwner = record.lease.runtimeKind
  const direction = recoverableOwner === 'native' ? 'to-tui' : 'to-native'
  return {
    owner: recoverableOwner,
    direction,
    phase: 'failed',
    stage: 'old-owner-stopped',
    operationId: record.lease.handoffOperationId,
    error: {
      message:
        direction === 'to-tui'
          ? "Couldn't open the agent terminal — chat still owns this session"
          : "Couldn't resume chat — the agent terminal still owns this session",
      recoverableOwner
    }
  }
}

export function structuredSessionHasPendingPrompt(journal: AgentSessionJournal): boolean {
  return journal
    .snapshot()
    .items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending'
    )
}

export function switchingStructuredHandoffStatus(
  record: AgentSessionRecord,
  direction: 'to-tui' | 'to-native',
  hostLabel?: string
): AgentSessionHandoffStatus {
  return {
    owner: record.lease.ownerProcess ? record.lease.runtimeKind : 'none',
    direction,
    phase: 'switching',
    stage: record.lease.handoffStage,
    operationId: record.lease.handoffOperationId,
    ...(hostLabel ? { hostLabel } : {})
  }
}

export function failedStructuredHandoffStatus(
  record: AgentSessionRecord,
  params: AgentSessionHandoffRequest,
  error: unknown,
  hostLabel?: string
): AgentSessionHandoffStatus {
  const recoverableOwner =
    record.lease.handoffStage === 'manual-recovery'
      ? 'none'
      : record.lease.handoffStage === 'old-owner-stopped' && record.lease.claimStatus === 'released'
        ? record.lease.runtimeKind
        : record.lease.ownerProcess
          ? record.lease.runtimeKind
          : params.direction === 'to-tui' && record.lease.runtimeKind === 'native'
            ? 'native'
            : 'none'
  const canRetryProof = structuredTuiRecoveryProofIsAdmissible(record)
  return {
    owner: recoverableOwner,
    direction: params.direction,
    phase: 'failed',
    stage: record.lease.handoffStage,
    operationId: params.envelope.clientOperationId,
    ...(hostLabel ? { hostLabel } : {}),
    error: {
      message:
        recoverableOwner === 'none'
          ? "Couldn't verify which runtime owns this session — manual recovery is required"
          : params.direction === 'to-tui'
            ? "Couldn't open the agent terminal — chat still owns this session"
            : "Couldn't resume chat — the agent terminal still owns this session",
      details: error instanceof Error ? error.message : String(error),
      recoverableOwner,
      ...(canRetryProof ? { canRetryProof: true } : {})
    }
  }
}

/** A latched TUI with a recorded process can be re-proved, regardless of which acquisition
 * phase was interrupted. The operation ledger, not the lease, records the failed attempt. */
export function structuredTuiRecoveryProofIsAdmissible(record: AgentSessionRecord): boolean {
  return (
    (record.lease.handoffStage === 'recovering' ||
      record.lease.handoffStage === 'manual-recovery') &&
    record.lease.runtimeKind === 'tui' &&
    record.lease.ownerProcess !== null &&
    ((record.lease.claimStatus === 'reserved' && record.lease.handoffOperationId !== null) ||
      (record.lease.claimStatus === 'live' && record.lease.handoffOperationId === null))
  )
}
