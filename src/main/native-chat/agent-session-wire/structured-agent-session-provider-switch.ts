import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { performProviderSwitch } from './structured-agent-session-provider-switch-owner'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  computeAgentSessionPayloadFingerprint,
  agentSessionFingerprintConflict
} from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSwitchProviderResult
} from '../../../shared/agent-session-wire'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal
} from './structured-agent-session-adapter'
import { classifyStoreFailure } from './structured-agent-session-attach'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  AGENT_SESSION_NOT_ATTACHED,
  refuseAgentSessionMutation
} from './structured-agent-session-mutation-admission'
import { refuseStructuredProviderSwitch } from './structured-agent-session-provider-switch-admission'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'

export type StructuredAgentSessionSwitchProviderParams = {
  envelope: AgentSessionMutationEnvelope
  agent: AgentSessionSwitchProviderResult['agent']
  provider: AgentSessionHandleProvider
  accountHome: AgentSessionAccountHome
  model?: string
}

export type StructuredAgentSessionSwitchContext = Pick<
  StructuredAgentSessionMutationContext,
  'deps' | 'sessions' | 'publish' | 'now'
> & {
  eventSink: (sessionId: string) => DeferredStructuredAgentSessionEventSink
  publishFence: (sessionId: string) => void
  discardEventSink: (sessionId: string) => void
  mintSpawnToken: () => string
}

const METHOD = 'agentSession.switchProvider'

export function switchProviderFingerprintFields(
  params: Pick<StructuredAgentSessionSwitchProviderParams, 'agent' | 'model'>
): Record<string, unknown> {
  return params.model ? { agent: params.agent, model: params.model } : { agent: params.agent }
}

export async function switchStructuredAgentSessionProvider(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: StructuredAgentSessionSwitchProviderParams
): Promise<AgentSessionMutationResult<AgentSessionSwitchProviderResult>> {
  const sessionId = params.envelope.sessionId
  return context.serialize(sessionId, () =>
    runSwitch(
      {
        deps: context.deps,
        sessions: context.sessions,
        now: context.now,
        publish: (id, journal) => context.subscribers.publish(id, journal),
        eventSink: (id) => context.runtimeState.eventSinkFor(id),
        discardEventSink: (id) => context.runtimeState.discardEventSink(id),
        mintSpawnToken: () => context.deps.mintSpawnToken?.() ?? randomUUID(),
        publishFence: (id) => {
          const session = context.sessions.get(id)!
          context.subscribers.snapshot(id, session.journal, session.fence)
        }
      },
      callerKey,
      params
    )
  )
}

async function runSwitch(
  context: StructuredAgentSessionSwitchContext,
  callerKey: string,
  params: StructuredAgentSessionSwitchProviderParams
): Promise<AgentSessionMutationResult<AgentSessionSwitchProviderResult>> {
  const sessionId = params.envelope.sessionId
  const session = context.sessions.get(sessionId)
  const record = context.deps.store.getRecord(sessionId)
  if (!session || !record) {
    return refuseAgentSessionMutation(AGENT_SESSION_NOT_ATTACHED)
  }
  const fields = switchProviderFingerprintFields(params)
  const hostFingerprint = computeAgentSessionPayloadFingerprint({
    method: METHOD,
    sessionId,
    fields
  })
  const conflict = agentSessionFingerprintConflict(params.envelope, hostFingerprint)
  if (conflict) {
    return refuseAgentSessionMutation(conflict)
  }
  const ledger = await context.deps.store.admitOperation({
    callerKey,
    operationId: params.envelope.clientOperationId,
    fingerprint: hostFingerprint,
    now: context.now()
  })
  const value = { agent: params.agent, provider: params.provider }
  if (ledger.decision === 'refused') {
    return refuseAgentSessionMutation({
      code: ledger.code,
      message: `Operation ${params.envelope.clientOperationId} was refused: ${ledger.code}.`
    })
  }
  if (ledger.decision === 'replay') {
    const replay = resolveAgentSessionReplayOutcome({
      operationId: params.envelope.clientOperationId,
      outcome: ledger.row.outcome,
      reconstruct: () => (ledger.row.outcome.status === 'succeeded' ? value : null)
    })
    if (replay.decision === 'refuse') {
      return refuseAgentSessionMutation(replay.refusal)
    }
    if (replay.decision === 'replay') {
      const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? session.fence
      return {
        ok: true,
        replayed: true,
        fence,
        cursor: session.journal.cursor(),
        value: replay.value
      }
    }
  }
  {
    const leaseRefusal = refuseStructuredProviderSwitch(
      record.lease,
      params.envelope.expectedRuntimeFence
    )
    if (leaseRefusal) {
      return refuseAgentSessionMutation(leaseRefusal)
    }
  }
  try {
    await performProviderSwitch(context, callerKey, params)
  } catch (error) {
    if (error instanceof AgentSessionAcquisitionExitUnprovenError) {
      return refuseAgentSessionMutation({
        code: 'agent_session_ownership_unknown',
        message: 'The provider owner is unverifiable.'
      })
    }
    if (isAgentSessionOptionRejectedError(error)) {
      return refuseAgentSessionMutation({
        code: 'agent_session_operation_invalid',
        message: error.message
      })
    }
    if (error instanceof AgentSessionAcquisitionRefusal) {
      return { ok: false, refusal: { code: error.code, message: error.message } }
    }
    return {
      ok: false,
      refusal: classifyStoreFailure(
        error,
        context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null,
        context.deps.store.getRecord(sessionId)
      )
    }
  }
  const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? session.fence
  return { ok: true, replayed: false, fence, cursor: session.journal.cursor(), value }
}
