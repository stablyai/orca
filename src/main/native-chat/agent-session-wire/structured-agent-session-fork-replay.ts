import { randomUUID } from 'node:crypto'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'

export async function prepareStructuredForkReplay(
  context: Pick<StructuredAgentSessionMutationContext, 'deps' | 'sessions' | 'now'>,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams
): Promise<{
  params: AgentSessionAttachParams
  result?: AgentSessionMutationResult<AgentSessionAttachResult>
}> {
  const sessionId = params.envelope.sessionId
  const record = context.deps.store.getRecord(sessionId)
  const fork = record?.fork
  if (!fork || fork.phase === 'prepared' || fork.phase === 'attempted') {
    return { params }
  }
  const attached = context.sessions.get(sessionId)
  if (fork.phase === 'completed' && attached) {
    return {
      params,
      result: {
        ok: true,
        replayed: true,
        fence: attached.fence,
        cursor: attached.journal.cursor(),
        value: {
          sessionId,
          fence: attached.fence,
          page: readAgentSessionHydrationPage(attached.journal, attached.fence),
          unconfirmedClientMessageIds: []
        }
      }
    }
  }
  const previous = context.deps.store
    .listOperationRows()
    .find(
      (row) => row.callerKey === caller.callerKey && row.operationId === fork.recoveryOperationId
    )
  const operationId =
    previous && previous.outcome.status !== 'failed'
      ? fork.recoveryOperationId!
      : `${context.now()}-${randomUUID().replaceAll('-', '')}`
  const expectedFence =
    previous && previous.outcome.status !== 'failed'
      ? fork.recoveryExpectedFence!
      : record.lease.runtimeFence
  if (operationId !== fork.recoveryOperationId) {
    await context.deps.store.transitionHandoff(sessionId, (current) => {
      if (
        current.lease.runtimeFence !== record.lease.runtimeFence ||
        current.fork?.phase !== fork.phase
      ) {
        throw new Error('agent_session_checkpoint_stale')
      }
      return {
        ...current,
        fork: { ...fork, recoveryOperationId: operationId, recoveryExpectedFence: expectedFence }
      }
    })
  }
  const recovery = {
    ...params,
    envelope: {
      ...params.envelope,
      clientOperationId: operationId,
      expectedRuntimeFence: expectedFence
    }
  }
  recovery.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId,
    fields: attachFingerprintFields(recovery)
  })
  return { params: recovery }
}
