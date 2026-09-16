import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import {
  abandonStoredAgentSessionHandoffAttempt,
  setStoredAgentSessionHandoffStage,
  stopStoredAgentSessionOwnerForHandoff
} from '../../runtime/agent-session-handoff-record-transitions'
import { handoffStructuredSessionToTui } from './structured-agent-session-handoff-forward'
import { handoffStructuredSessionToNative } from './structured-agent-session-handoff-reverse'
import {
  idleStructuredHandoffStatus,
  structuredTuiRecoveryProofIsAdmissible
} from './structured-agent-session-handoff-status'
import type { StructuredTuiOwner } from './structured-agent-session-handoff-types'
import {
  persistReprovedTuiOwner,
  recoverTuiOwnerOrContinue,
  recoverUnavailableTuiAsNative,
  type StructuredAgentSessionRestartAccess
} from './structured-agent-session-handoff-restart-tui'

type RestartAccess = StructuredAgentSessionRestartAccess

export async function restoreStructuredAgentSessionHandoff(
  input: RestartAccess,
  sessionId: string
): Promise<void> {
  const initial = input.requireRecord(sessionId)
  const operationId = initial.lease.handoffOperationId
  const initialStage = initial.lease.handoffStage
  if (
    (initialStage === 'recovering' || initialStage === 'manual-recovery') &&
    !canRestoreLiveTuiOwner(initial)
  ) {
    if (operationId) {
      await input.deps.store.recordOperationOutcome({
        operationId,
        outcome: { status: 'failed', code: 'agent_session_ownership_unknown' }
      })
    }
    input.setStatus(sessionId, idleStructuredHandoffStatus(initial))
    return
  }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await restoreOnce(input, input.requireRecord(sessionId))
      const settled = input.requireRecord(sessionId)
      if (settled.lease.handoffStage !== null || settled.lease.handoffOperationId !== null) {
        throw new Error('Restart handoff reconciliation did not settle the transfer.')
      }
      if (operationId) {
        await input.deps.store.recordOperationOutcome({
          operationId,
          outcome: { status: 'succeeded', sessionId }
        })
      }
      return
    } catch (error) {
      lastError = error
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
      }
    }
  }
  const current = input.requireRecord(sessionId)
  const failed = await setStoredAgentSessionHandoffStage(input.deps.store, {
    sessionId,
    fence: current.lease.runtimeFence,
    stage: 'manual-recovery',
    // Keep a live TUI retryable after restart; other records retain the failed operation.
    handoffOperationId:
      current.lease.runtimeKind === 'tui' && current.lease.claimStatus === 'live'
        ? null
        : operationId,
    now: input.deps.now()
  })
  const status = idleStructuredHandoffStatus(failed)
  if (operationId) {
    await input.deps.store.recordOperationOutcome({
      operationId,
      outcome: { status: 'failed', code: 'agent_session_handoff_failed' }
    })
  }
  input.setStatus(sessionId, {
    ...status,
    ...(status.error
      ? {
          error: {
            ...status.error,
            details: lastError instanceof Error ? lastError.message : String(lastError)
          }
        }
      : {})
  })
}

async function restoreOnce(input: RestartAccess, record: AgentSessionRecord): Promise<void> {
  if (
    record.lease.handoffStage === null &&
    record.lease.claimStatus === 'released' &&
    record.lease.ownerProcess === null
  ) {
    // Reconcile already proved the owner gone: no transfer is in flight and there is no process to
    // recover, whatever kind the last owner was. Falling through would latch manual recovery on a
    // host with no TUI transport — a state a user then has to clear by hand, for nothing. (Startup
    // used to reach this path only for sessions it had not eagerly resumed, which is why removing
    // that resume is what made it visible.)
    return
  }
  if (canRestoreLiveTuiOwner(record)) {
    await restoreRecoverableLiveTui(input, record)
    return
  }
  if (!input.deps.transport) {
    if (record.lease.handoffStage !== null || record.lease.runtimeKind === 'tui') {
      throw new Error('Agent TUI handoff recovery is unavailable on this host.')
    }
    return
  }
  if (record.lease.handoffStage === null && record.lease.runtimeKind === 'tui') {
    await restoreLiveTui(input, record)
    return
  }
  if (!record.lease.handoffOperationId) {
    return
  }
  if (record.lease.handoffStage === 'preparing') {
    await restorePreparing(input, record)
    return
  }
  if (record.lease.handoffStage === 'new-owner-proving') {
    await restoreProving(input, record)
    return
  }
  if (record.lease.handoffStage === 'old-owner-stopped') {
    await continueHandoff(input, record)
  }
}

export function canRestoreLiveTuiOwner(record: AgentSessionRecord): boolean {
  return structuredTuiRecoveryProofIsAdmissible(record)
}

async function restoreRecoverableLiveTui(
  input: RestartAccess,
  record: AgentSessionRecord
): Promise<void> {
  if (!input.deps.transport) {
    throw new Error('Agent TUI handoff recovery is unavailable on this host.')
  }
  let owner: StructuredTuiOwner
  try {
    const recovered = await input.deps.transport.recoverTuiOwner(record)
    owner = await input.deps.transport.reproveTuiOwner({ record, owner: recovered })
    await persistReprovedTuiOwner(input, record.sessionId, owner)
  } catch (error) {
    const ownerState = await input.deps.transport.probeRecoveredOwner?.(record)
    if (ownerState !== 'dead') {
      throw error
    }
    await recoverUnavailableTuiAsNative(input, record, continueHandoff)
    return
  }
  let settled = input.deps.store.getRecord(record.sessionId) ?? record
  if (settled.lease.claimStatus === 'reserved') {
    settled = await setStoredAgentSessionHandoffStage(input.deps.store, {
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      stage: 'new-owner-proving',
      handoffOperationId: null,
      now: input.deps.now()
    })
    settled = await input.deps.store.proveOwner({
      sessionId: settled.sessionId,
      fence: settled.lease.runtimeFence,
      link: owner.link,
      now: input.deps.now()
    })
  } else {
    settled = await setStoredAgentSessionHandoffStage(input.deps.store, {
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      stage: null,
      handoffOperationId: null,
      now: input.deps.now()
    })
  }
  input.retainOwner(record.sessionId, owner)
  await startRecoveredTuiCatchup(input, record)
  input.setStatus(record.sessionId, {
    owner: 'tui',
    direction: null,
    phase: 'idle',
    stage: null,
    operationId: null,
    terminal: owner.terminal,
    hostLabel: input.deps.transport.hostLabel
  })
}

async function restoreLiveTui(input: RestartAccess, record: AgentSessionRecord): Promise<void> {
  const owner = await input.deps.transport!.recoverTuiOwner(record)
  await persistReprovedTuiOwner(input, record.sessionId, owner)
  input.retainOwner(record.sessionId, owner)
  await startRecoveredTuiCatchup(input, record)
  input.setStatus(record.sessionId, {
    owner: 'tui',
    direction: null,
    phase: 'idle',
    stage: null,
    operationId: null,
    terminal: owner.terminal,
    hostLabel: input.deps.transport?.hostLabel
  })
}

async function restorePreparing(input: RestartAccess, record: AgentSessionRecord): Promise<void> {
  if (record.lease.runtimeKind === 'tui') {
    const owner = await recoverTuiOwnerOrContinue(input, record, continueHandoff)
    if (!owner) {
      return
    }
    const settled = await setStoredAgentSessionHandoffStage(input.deps.store, {
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      stage: null,
      handoffOperationId: null,
      now: input.deps.now()
    })
    await restoreLiveTui(input, settled)
    return
  }
  await input.deps.transport!.stopRecoveredOwner(record)
  const stopped = await stopStoredAgentSessionOwnerForHandoff(input.deps.store, {
    sessionId: record.sessionId,
    expectedFence: record.lease.runtimeFence,
    operationId: record.lease.handoffOperationId!,
    now: input.deps.now()
  })
  await continueHandoff(input, stopped)
}

async function restoreProving(input: RestartAccess, record: AgentSessionRecord): Promise<void> {
  const operationId = record.lease.handoffOperationId!
  if (record.lease.runtimeKind === 'tui') {
    const reproved = await recoverTuiOwnerOrContinue(input, record, continueHandoff)
    if (!reproved) {
      return
    }
    await input.deps.store.proveOwner({
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      link: reproved.link,
      now: input.deps.now()
    })
    input.retainOwner(record.sessionId, reproved)
    await startRecoveredTuiCatchup(input, record)
    input.setStatus(record.sessionId, {
      owner: 'tui',
      direction: null,
      phase: 'idle',
      stage: null,
      operationId: null,
      terminal: reproved.terminal,
      hostLabel: input.deps.transport?.hostLabel
    })
    return
  }
  await input.deps.transport!.stopRecoveredOwner(record)
  const stopped = await abandonStoredAgentSessionHandoffAttempt(input.deps.store, {
    sessionId: record.sessionId,
    expectedFence: record.lease.runtimeFence,
    operationId,
    recoverableRuntimeKind: 'tui',
    now: input.deps.now()
  })
  await continueHandoff(input, stopped)
}

async function startRecoveredTuiCatchup(
  input: RestartAccess,
  record: AgentSessionRecord
): Promise<void> {
  await input.deps.recoverTuiHistoryCatchup?.(record.sessionId, record.lease.runtimeFence)
  await input.deps.activateTuiHistoryCatchup?.(record.sessionId)
}

async function continueHandoff(input: RestartAccess, record: AgentSessionRecord): Promise<void> {
  const direction = record.lease.runtimeKind === 'native' ? 'to-tui' : 'to-native'
  const operationId = record.lease.handoffOperationId!
  const params: AgentSessionHandoffRequest = {
    envelope: {
      sessionId: record.sessionId,
      clientOperationId: operationId,
      expectedRuntimeFence: record.lease.runtimeFence,
      payloadFingerprint: 'restart-reconciliation'
    },
    direction,
    mode: 'now',
    action: 'retry'
  }
  await (direction === 'to-tui'
    ? handoffStructuredSessionToTui(input.flowContext(), params, true)
    : handoffStructuredSessionToNative(input.flowContext(), params, true))
}
