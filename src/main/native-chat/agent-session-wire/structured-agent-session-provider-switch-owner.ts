import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import { structuredSwitchableAgentLabel } from '../../../shared/structured-agent-session-switchable-models'
import { AGENT_SESSION_LEASE_TTL_MS } from '../../runtime/agent-session-record-store'
import { replaceAgentSessionProvider } from '../../runtime/agent-session-provider-replacement'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal
} from './structured-agent-session-adapter'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { acquireSwitchedStructuredSessionOwner } from './structured-agent-session-provider-switch-acquire'
import type {
  StructuredAgentSessionSwitchContext,
  StructuredAgentSessionSwitchProviderParams
} from './structured-agent-session-provider-switch'

export async function performProviderSwitch(
  context: StructuredAgentSessionSwitchContext,
  callerKey: string,
  params: StructuredAgentSessionSwitchProviderParams
): Promise<void> {
  const sessionId = params.envelope.sessionId
  const session = context.sessions.get(sessionId)
  if (!session) {
    throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
  }
  const current = context.deps.store.getRecord(sessionId)!
  if (current.provider === params.provider && session.hasProviderChild) {
    throw new AgentSessionAcquisitionRefusal('Choose a model using the current provider.')
  }
  if (current.lease.claimStatus !== 'live' && current.lease.claimStatus !== 'released') {
    throw new AgentSessionAcquisitionRefusal(
      'The provider owner is unverifiable.',
      'agent_session_ownership_unknown'
    )
  }
  const turnId = activeStructuredAgentSessionTurnId(session.journal.snapshot().items)
  if (turnId) {
    throw new AgentSessionAcquisitionRefusal('Stop the current turn before switching providers.')
  }
  const eventSink = context.eventSink(sessionId)
  if (session.hasProviderChild) {
    const stop = context.deps.adapter.closeSession ?? context.deps.adapter.disposeSession
    if (!stop || (await stop.call(context.deps.adapter, sessionId)) !== true) {
      throw new AgentSessionAcquisitionExitUnprovenError('provider child exit was not proven')
    }
    session.hasProviderChild = false
  }
  const barrier = await eventSink.drained()
  if (!barrier.ok) {
    throw barrier.error
  }
  eventSink.unbind()
  const spawnToken = context.mintSpawnToken()
  const replaced = {
    record: await context.deps.store.transitionHandoff(
      sessionId,
      (record) =>
        replaceAgentSessionProvider({
          record,
          expectedFence: session.fence,
          provider: params.provider,
          accountHome: params.accountHome,
          spawnToken,
          claimKeyId: context.deps.claimKeyId,
          handoffOperationId: params.envelope.clientOperationId,
          now: context.now(),
          leaseTtlMs: AGENT_SESSION_LEASE_TTL_MS,
          ...(params.model ? { model: params.model } : {})
        }).record
    )
  }
  session.params = {
    envelope: params.envelope,
    location: session.params.location,
    provider: params.provider,
    agent: params.agent,
    accountHome: params.accountHome,
    runtimeKind: 'native'
  }
  session.fence = replaced.record.lease.runtimeFence
  session.replacingProvider = true
  try {
    await session.journal.appendItem(
      { provider: 'orca', clientMessageId: `provider-switch:${session.fence}` },
      { kind: 'status', text: `Switching to ${structuredSwitchableAgentLabel(params.agent)}.` },
      { fence: session.fence }
    )
    const acquired = await acquireSwitchedStructuredSessionOwner(context, params, replaced.record)
    session.hasProviderChild = true
    session.replacingProvider = false
    session.acquisitionGeneration = acquired.acquisitionGeneration
    session.fence = acquired.record.lease.runtimeFence
    eventSink.bind({
      journal: session.journal,
      fence: session.fence,
      publish: () => context.publish(sessionId, session.journal)
    })
    const barrier = await eventSink.drained()
    if (!barrier.ok) {
      throw barrier.error
    }
    await session.journal.appendItem(
      { provider: 'orca', clientMessageId: `provider-switch:${session.fence}` },
      { kind: 'status', text: `Now talking to ${structuredSwitchableAgentLabel(params.agent)}.` },
      { fence: session.fence }
    )
    context.publishFence(sessionId)
    await context.deps.store.recordOperationOutcome({
      callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'succeeded', sessionId }
    })
  } catch (error) {
    session.replacingProvider = false
    if (session.hasProviderChild) {
      context.publishFence(sessionId)
      throw error
    }
    eventSink.close()
    context.discardEventSink(sessionId)
    const failedToken = replaced.record.lease.reservedSpawnToken
    if (failedToken) {
      const settled = await context.deps.store.settleFailedAcquisition({
        sessionId,
        fence: replaced.record.lease.runtimeFence,
        spawnToken: failedToken,
        callerKey,
        operationId: params.envelope.clientOperationId,
        outcome: {
          status: 'failed',
          code: 'agent_session_operation_invalid',
          message: error instanceof Error ? error.message : String(error)
        },
        exitProof:
          error instanceof AgentSessionAcquisitionExitUnprovenError ? 'unproven' : 'exit-proven',
        now: context.now()
      })
      session.fence = settled.lease.runtimeFence
    }
    context.publishFence(sessionId)
    throw error
  }
}
