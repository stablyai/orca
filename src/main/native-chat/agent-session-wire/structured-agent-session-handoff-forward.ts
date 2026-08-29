import { randomUUID } from 'node:crypto'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import {
  abandonStoredAgentSessionHandoffAttempt,
  rollbackStoredAgentSessionHandoffPreparation,
  reserveStoredAgentSessionHandoffOwner,
  stopStoredAgentSessionOwnerForHandoff
} from '../../runtime/agent-session-handoff-record-transitions'
import { AgentSessionAcquisitionExitUnprovenError } from './structured-agent-session-adapter'
import { markStructuredHandoffManualRecovery } from './structured-agent-session-handoff-flow-context'
import type {
  StructuredAgentSessionHandoffFlowContext,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'
import { StructuredTuiLaunchCleanupError } from './structured-agent-session-handoff-types'

export async function handoffStructuredSessionToTui(
  context: StructuredAgentSessionHandoffFlowContext,
  params: AgentSessionHandoffRequest,
  retry: boolean
): Promise<void> {
  const { deps } = context
  const sessionId = params.envelope.sessionId
  const operationId = params.envelope.clientOperationId
  let record = context.requireRecord(sessionId)
  if (retry && record.lease.handoffStage === 'old-owner-stopped') {
    record = await recoverNativeAfterTuiFailure(context, sessionId, operationId)
  }
  if (record.lease.handoffStage === null) {
    await context.enterPreparing(record, operationId, 'to-tui')
  } else if (
    record.lease.handoffStage !== 'preparing' ||
    record.lease.handoffOperationId !== operationId
  ) {
    throw new Error('agent_session_operation_conflict')
  }
  record = context.requireRecord(sessionId)
  // A kill is a request. Everything below advances the fence and hands the
  // provider session to a TUI, so an unproven exit must stop here rather than
  // create a second live writer on the same thread.
  let nativeSuspend
  try {
    nativeSuspend = await deps.suspendNative(sessionId)
  } catch (error) {
    await rollbackPreparingNativeOwner(context, sessionId, operationId)
    throw error
  }
  if (nativeSuspend.state === 'live') {
    await rollbackPreparingNativeOwner(context, sessionId, operationId)
    throw new Error('agent_session_owner_exit_unproven')
  }
  record = await stopStoredAgentSessionOwnerForHandoff(deps.store, {
    sessionId,
    expectedFence: record.lease.runtimeFence,
    operationId,
    now: deps.now()
  })
  context.publishStage(record, 'to-tui')
  if (nativeSuspend.state === 'stopped-cleanup-failed') {
    await markStructuredHandoffManualRecovery(context, sessionId, operationId)
    throw nativeSuspend.error
  }
  const spawnToken = randomUUID()
  record = await reserveStoredAgentSessionHandoffOwner(deps.store, {
    sessionId,
    expectedFence: record.lease.runtimeFence,
    runtimeKind: 'tui',
    spawnToken,
    operationId,
    claimKeyId: deps.claimKeyId,
    now: deps.now()
  })
  context.publishStage(record, 'to-tui')
  let owner: StructuredTuiOwner | null = null
  let processIdentityCommitted = false
  try {
    await deps.prepareTuiHistoryCatchup?.(sessionId, record.lease.runtimeFence)
    owner = await deps.transport!.launchTui({
      record,
      fence: record.lease.runtimeFence,
      spawnToken,
      onSpawned: async (spawnedOwner) => {
        owner = spawnedOwner
        await deps.store.commitProcessIdentity({
          sessionId,
          fence: record.lease.runtimeFence,
          process: spawnedOwner.process,
          now: deps.now()
        })
        processIdentityCommitted = true
      }
    })
    if (!processIdentityCommitted) {
      await deps.store.commitProcessIdentity({
        sessionId,
        fence: record.lease.runtimeFence,
        process: owner.process,
        now: deps.now()
      })
    }
    record = await deps.store.proveOwner({
      sessionId,
      fence: record.lease.runtimeFence,
      link: owner.link,
      now: deps.now()
    })
  } catch (error) {
    deps.stopTuiHistoryCatchup?.(sessionId)
    if (!owner && error instanceof StructuredTuiLaunchCleanupError) {
      await markStructuredHandoffManualRecovery(context, sessionId, operationId)
      throw error
    }
    if (owner) {
      if (!deps.transport?.stopFailedTuiLaunch) {
        context.retainOwner(sessionId, owner)
        await markStructuredHandoffManualRecovery(context, sessionId, operationId)
        throw error
      }
      try {
        await deps.transport.stopFailedTuiLaunch(owner)
      } catch (stopError) {
        context.retainOwner(sessionId, owner)
        await markStructuredHandoffManualRecovery(context, sessionId, operationId)
        throw new AggregateError(
          [error, stopError],
          'The failed terminal launch could not be proven stopped.'
        )
      }
    }
    await recoverNativeAfterTuiFailure(context, sessionId, operationId)
    throw error
  }
  context.retainOwner(sessionId, owner)
  await deps.activateTuiHistoryCatchup?.(sessionId)
  context.setStatus(sessionId, {
    owner: 'tui',
    direction: null,
    phase: 'idle',
    stage: record.lease.handoffStage,
    operationId: record.lease.handoffOperationId,
    terminal: owner.terminal,
    hostLabel: deps.transport?.hostLabel
  })
}

async function rollbackPreparingNativeOwner(
  context: StructuredAgentSessionHandoffFlowContext,
  sessionId: string,
  operationId: string
): Promise<void> {
  const { deps } = context
  const current = context.requireRecord(sessionId)
  if (
    current.lease.handoffStage === 'preparing' &&
    current.lease.handoffOperationId === operationId &&
    current.lease.claimStatus === 'live'
  ) {
    await rollbackStoredAgentSessionHandoffPreparation(deps.store, {
      sessionId,
      expectedFence: current.lease.runtimeFence,
      operationId,
      now: deps.now()
    })
  }
}

async function recoverNativeAfterTuiFailure(
  context: StructuredAgentSessionHandoffFlowContext,
  sessionId: string,
  operationId: string
) {
  const { deps } = context
  let record = context.requireRecord(sessionId)
  if (record.lease.handoffStage === 'new-owner-proving') {
    record = await abandonStoredAgentSessionHandoffAttempt(deps.store, {
      sessionId,
      expectedFence: record.lease.runtimeFence,
      operationId,
      recoverableRuntimeKind: 'native',
      now: deps.now()
    })
  }
  const spawnToken = randomUUID()
  record = await reserveStoredAgentSessionHandoffOwner(deps.store, {
    sessionId,
    expectedFence: record.lease.runtimeFence,
    runtimeKind: 'native',
    spawnToken,
    operationId,
    claimKeyId: deps.claimKeyId,
    now: deps.now()
  })
  try {
    return await deps.acquireNative({
      sessionId,
      fence: record.lease.runtimeFence,
      spawnToken
    })
  } catch (error) {
    if (error instanceof AgentSessionAcquisitionExitUnprovenError) {
      await markStructuredHandoffManualRecovery(context, sessionId, operationId)
      throw error
    }
    const current = context.requireRecord(sessionId)
    if (current.lease.handoffStage === 'new-owner-proving') {
      await abandonStoredAgentSessionHandoffAttempt(deps.store, {
        sessionId,
        expectedFence: current.lease.runtimeFence,
        operationId,
        recoverableRuntimeKind: 'native',
        now: deps.now()
      })
    }
    throw error
  }
}
