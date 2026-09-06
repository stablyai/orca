import { randomUUID } from 'node:crypto'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  abandonStoredAgentSessionHandoffAttempt,
  stopStoredAgentSessionOwnerForHandoff,
  stopStoredRecoveringTuiOwnerForHandoff
} from '../../runtime/agent-session-handoff-record-transitions'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredAgentSessionHandoffFlowContext,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

export type StructuredAgentSessionRestartAccess = {
  deps: StructuredAgentSessionHandoffDeps
  requireRecord: (sessionId: string) => AgentSessionRecord
  flowContext: () => StructuredAgentSessionHandoffFlowContext
  retainOwner: (sessionId: string, owner: StructuredTuiOwner) => void
  setStatus: (sessionId: string, status: AgentSessionHandoffStatus) => void
}

type ContinueHandoff = (
  input: StructuredAgentSessionRestartAccess,
  record: AgentSessionRecord
) => Promise<void>

export async function recoverUnavailableTuiAsNative(
  input: StructuredAgentSessionRestartAccess,
  record: AgentSessionRecord,
  continueHandoff: ContinueHandoff
): Promise<void> {
  await input.deps.transport!.stopRecoveredOwner(record)
  if (record.lease.handoffStage === 'preparing') {
    const stopped = await stopStoredAgentSessionOwnerForHandoff(input.deps.store, {
      sessionId: record.sessionId,
      expectedFence: record.lease.runtimeFence,
      operationId: record.lease.handoffOperationId!,
      now: input.deps.now()
    })
    await continueHandoff(input, stopped)
    return
  }
  if (record.lease.handoffStage === 'new-owner-proving') {
    const abandoned = await abandonStoredAgentSessionHandoffAttempt(input.deps.store, {
      sessionId: record.sessionId,
      expectedFence: record.lease.runtimeFence,
      operationId: record.lease.handoffOperationId!,
      recoverableRuntimeKind: 'native',
      now: input.deps.now()
    })
    await continueHandoff(input, abandoned)
    return
  }
  const operationId = createStructuredAgentSessionOperationId(randomUUID, input.deps.now())
  const stopped = await stopStoredRecoveringTuiOwnerForHandoff(input.deps.store, {
    sessionId: record.sessionId,
    expectedFence: record.lease.runtimeFence,
    operationId,
    now: input.deps.now()
  })
  await continueHandoff(input, stopped)
}

export async function recoverTuiOwnerOrContinue(
  input: StructuredAgentSessionRestartAccess,
  record: AgentSessionRecord,
  continueHandoff: ContinueHandoff
): Promise<StructuredTuiOwner | null> {
  try {
    const owner = await input.deps.transport!.recoverTuiOwner(record)
    const reproved = await input.deps.transport!.reproveTuiOwner({ record, owner })
    await persistReprovedTuiOwner(input, record.sessionId, reproved)
    return reproved
  } catch (error) {
    const ownerState = await input.deps.transport!.probeRecoveredOwner?.(record)
    if (ownerState !== 'dead') {
      throw error
    }
    await recoverUnavailableTuiAsNative(input, record, continueHandoff)
    return null
  }
}

export async function persistReprovedTuiOwner(
  input: StructuredAgentSessionRestartAccess,
  sessionId: string,
  owner: StructuredTuiOwner
): Promise<void> {
  if (owner.link.origin === 'resumed') {
    await input.deps.persistTuiProviderHandle?.({
      sessionId,
      link: owner.link,
      now: input.deps.now()
    })
  }
}
