import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import { setStoredAgentSessionHandoffStage } from '../../runtime/agent-session-handoff-record-transitions'
import { switchingStructuredHandoffStatus } from './structured-agent-session-handoff-status'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredAgentSessionHandoffFlowContext,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

export function createStructuredHandoffFlowContext(input: {
  deps: StructuredAgentSessionHandoffDeps
  owner: (sessionId: string) => StructuredTuiOwner | undefined
  retainOwner: (sessionId: string, owner: StructuredTuiOwner) => void
  releaseOwner: (sessionId: string) => void
  setStatus: (sessionId: string, status: AgentSessionHandoffStatus) => void
  requireRecord: (sessionId: string) => AgentSessionRecord
}): StructuredAgentSessionHandoffFlowContext {
  const publishStage: StructuredAgentSessionHandoffFlowContext['publishStage'] = (
    record,
    direction
  ) => {
    input.setStatus(
      record.sessionId,
      switchingStructuredHandoffStatus(record, direction, input.deps.transport?.hostLabel)
    )
  }
  return {
    ...input,
    publishStage,
    enterPreparing: async (record, operationId, direction) => {
      const prepared = await setStoredAgentSessionHandoffStage(input.deps.store, {
        sessionId: record.sessionId,
        fence: record.lease.runtimeFence,
        stage: 'preparing',
        handoffOperationId: operationId,
        now: input.deps.now()
      })
      publishStage(prepared, direction)
    }
  }
}

export function requireStructuredHandoffRecord(
  deps: StructuredAgentSessionHandoffDeps,
  sessionId: string
): AgentSessionRecord {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  return record
}

export async function markStructuredHandoffManualRecovery(
  context: StructuredAgentSessionHandoffFlowContext,
  sessionId: string,
  _operationId: string
): Promise<void> {
  const record = context.requireRecord(sessionId)
  await setStoredAgentSessionHandoffStage(context.deps.store, {
    sessionId,
    fence: record.lease.runtimeFence,
    stage: 'manual-recovery',
    // A live TUI is still recoverable without an active operation; other records retain the
    // failed operation so native/manual proof retries remain idempotent.
    handoffOperationId:
      record.lease.runtimeKind === 'tui' && record.lease.claimStatus === 'live'
        ? null
        : _operationId,
    now: context.deps.now()
  })
}

export async function stopStructuredNativeTurn(
  deps: StructuredAgentSessionHandoffDeps,
  sessionId: string,
  turnId: string
): Promise<boolean> {
  const record = deps.store.getRecord(sessionId)
  if (!record || record.lease.runtimeKind !== 'native') {
    return false
  }
  const session = deps.session(sessionId)
  return (await deps.acquireNativeStop?.(sessionId, turnId, session.fence)) ?? false
}
