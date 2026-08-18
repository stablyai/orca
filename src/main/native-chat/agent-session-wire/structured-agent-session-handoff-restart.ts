import { randomUUID } from 'node:crypto'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffStatus
} from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  abandonStoredAgentSessionHandoffAttempt,
  setStoredAgentSessionHandoffStage,
  stopStoredAgentSessionOwnerForHandoff,
  stopStoredRecoveringTuiOwnerForHandoff
} from '../../runtime/agent-session-handoff-record-transitions'
import { handoffStructuredSessionToTui } from './structured-agent-session-handoff-forward'
import { handoffStructuredSessionToNative } from './structured-agent-session-handoff-reverse'
import { idleStructuredHandoffStatus } from './structured-agent-session-handoff-status'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredAgentSessionHandoffFlowContext,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

type RestartAccess = {
  deps: StructuredAgentSessionHandoffDeps
  requireRecord: (sessionId: string) => AgentSessionRecord
  flowContext: () => StructuredAgentSessionHandoffFlowContext
  retainOwner: (sessionId: string, owner: StructuredTuiOwner) => void
  setStatus: (sessionId: string, status: AgentSessionHandoffStatus) => void
}

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
    handoffOperationId: current.lease.handoffOperationId,
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

async function recoverUnavailableTuiAsNative(
  input: RestartAccess,
  record: AgentSessionRecord
): Promise<void> {
  await input.deps.transport!.stopRecoveredOwner(record)
  const operationId = createStructuredAgentSessionOperationId(randomUUID, input.deps.now())
  const stopped = await stopStoredRecoveringTuiOwnerForHandoff(input.deps.store, {
    sessionId: record.sessionId,
    expectedFence: record.lease.runtimeFence,
    operationId,
    now: input.deps.now()
  })
  await continueHandoff(input, stopped)
}

export function canRestoreLiveTuiOwner(record: AgentSessionRecord): boolean {
  return (
    (record.lease.handoffStage === 'recovering' ||
      record.lease.handoffStage === 'manual-recovery') &&
    record.lease.runtimeKind === 'tui' &&
    record.lease.claimStatus === 'live' &&
    record.lease.ownerProcess !== null &&
    record.lease.handoffOperationId === null
  )
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
  } catch (error) {
    const ownerState = await input.deps.transport.probeRecoveredOwner?.(record)
    if (ownerState !== 'dead') {
      throw error
    }
    await recoverUnavailableTuiAsNative(input, record)
    return
  }
  await setStoredAgentSessionHandoffStage(input.deps.store, {
    sessionId: record.sessionId,
    fence: record.lease.runtimeFence,
    stage: null,
    handoffOperationId: null,
    now: input.deps.now()
  })
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
    const owner = await input.deps.transport!.recoverTuiOwner(record)
    await input.deps.transport!.reproveTuiOwner({ record, owner })
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
    const owner = await input.deps.transport!.recoverTuiOwner(record)
    const reproved = await input.deps.transport!.reproveTuiOwner({ record, owner })
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
