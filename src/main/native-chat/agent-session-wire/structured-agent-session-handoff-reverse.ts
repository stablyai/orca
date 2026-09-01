import { randomUUID } from 'node:crypto'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import {
  abandonStoredAgentSessionHandoffAttempt,
  reserveStoredAgentSessionHandoffOwner,
  rollbackStoredAgentSessionHandoffPreparation,
  stopStoredAgentSessionOwnerForHandoff
} from '../../runtime/agent-session-handoff-record-transitions'
import { AgentSessionAcquisitionExitUnprovenError } from './structured-agent-session-adapter'
import { markStructuredHandoffManualRecovery } from './structured-agent-session-handoff-flow-context'
import type { StructuredAgentSessionHandoffFlowContext } from './structured-agent-session-handoff-types'

export async function handoffStructuredSessionToNative(
  context: StructuredAgentSessionHandoffFlowContext,
  params: AgentSessionHandoffRequest,
  retry: boolean,
  tuiAlreadyExited = false
): Promise<void> {
  const { deps } = context
  const sessionId = params.envelope.sessionId
  const operationId = params.envelope.clientOperationId
  let record = context.requireRecord(sessionId)
  let owner = context.owner(sessionId)
  let transcriptPath = owner?.transcriptPath
  if (!retry || record.lease.handoffStage === 'preparing' || record.lease.handoffStage === null) {
    if (record.lease.handoffStage === null) {
      await context.enterPreparing(record, operationId, 'to-native')
    }
    record = context.requireRecord(sessionId)
    try {
      if (!owner) {
        throw new Error('The owning agent terminal could not be identified.')
      }
      if (!tuiAlreadyExited) {
        owner = await deps.transport!.reproveTuiOwner({ record, owner })
        context.retainOwner(sessionId, owner)
        if (owner.link.origin === 'resumed') {
          await deps.persistTuiProviderHandle?.({ sessionId, link: owner.link, now: deps.now() })
        }
      }
      transcriptPath = owner.transcriptPath ?? transcriptPath
      if (owner.link.handle.provider === 'codex' && !transcriptPath) {
        throw new Error(
          'The Codex terminal has not written a durable rollout yet. Send a prompt before switching to structured chat.'
        )
      }
      context.setStatus(sessionId, {
        owner: 'tui',
        direction: 'to-native',
        phase: 'waiting-for-exit',
        stage: 'preparing',
        operationId,
        terminal: owner.terminal,
        hostLabel: deps.transport?.hostLabel
      })
      const exited = deps.transport!.closeTuiOwner
        ? await deps.transport!.closeTuiOwner(owner)
        : await deps.transport!.waitForTuiExit(owner)
      transcriptPath = exited.transcriptPath ?? owner.transcriptPath
    } catch (error) {
      const current = context.requireRecord(sessionId)
      if (
        current.lease.handoffStage === 'preparing' &&
        current.lease.handoffOperationId === operationId &&
        current.lease.claimStatus === 'live' &&
        current.lease.ownerProcess
      ) {
        await rollbackStoredAgentSessionHandoffPreparation(deps.store, {
          sessionId,
          expectedFence: current.lease.runtimeFence,
          operationId,
          now: deps.now()
        })
      }
      throw error
    }
    record = await stopStoredAgentSessionOwnerForHandoff(deps.store, {
      sessionId,
      expectedFence: record.lease.runtimeFence,
      operationId,
      now: deps.now()
    })
    context.publishStage(record, 'to-native')
  } else if (
    record.lease.handoffStage !== 'old-owner-stopped' ||
    record.lease.handoffOperationId !== operationId
  ) {
    throw new Error('agent_session_operation_conflict')
  }
  deps.stopTuiHistoryCatchup?.(sessionId)
  if (owner?.historySource !== 'provider-resume') {
    await deps.importTuiHistory({
      sessionId,
      fence: record.lease.runtimeFence,
      ...(transcriptPath ? { transcriptPath } : {})
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
  context.publishStage(record, 'to-native')
  try {
    record = await deps.acquireNative({
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
        recoverableRuntimeKind: 'tui',
        now: deps.now()
      })
    }
    throw error
  }
  context.releaseOwner(sessionId)
  await deps.transport?.revealNativeSession?.({
    workspaceId: record.location.workspaceId,
    sessionId,
    agent: record.provider,
    ...(owner?.adoptedTerminal ? { adoptedTerminal: true } : {})
  })
  context.setStatus(sessionId, {
    owner: 'native',
    direction: null,
    phase: 'idle',
    stage: record.lease.handoffStage,
    operationId: record.lease.handoffOperationId
  })
}
