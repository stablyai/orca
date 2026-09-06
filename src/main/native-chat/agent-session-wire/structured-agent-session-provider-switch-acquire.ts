import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'
import { journalIdentityFor } from './structured-agent-session-attach'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import type {
  StructuredAgentSessionSwitchContext,
  StructuredAgentSessionSwitchProviderParams
} from './structured-agent-session-provider-switch'

export async function acquireSwitchedStructuredSessionOwner(
  context: StructuredAgentSessionSwitchContext,
  params: StructuredAgentSessionSwitchProviderParams,
  record: AgentSessionRecord
): Promise<{ record: AgentSessionRecord; acquisitionGeneration: string | null }> {
  const sessionId = params.envelope.sessionId
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  try {
    try {
      record = await context.deps.store.setReservationProcesslessProof({
        sessionId,
        fence,
        spawnToken,
        processlessAt: null,
        now: context.now()
      })
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    const acquired = await context.deps.adapter.acquire({
      identity: journalIdentityFor(record, {
        envelope: params.envelope,
        location: record.location,
        provider: params.provider,
        agent: params.agent,
        accountHome: params.accountHome,
        runtimeKind: 'native'
      }),
      fence,
      spawnToken,
      ...(record.options ? { options: record.options } : {}),
      events: context.eventSink(sessionId).sink
    })
    if (params.model) {
      await context.deps.adapter.setOption({ sessionId, fence, key: 'model', value: params.model })
    }
    const options = await readNativeSessionOptions({
      adapter: context.deps.adapter,
      sessionId,
      fence,
      ...(record.options ? { priorOptions: record.options } : {})
    })
    if (record.lease.ownerProcess === null) {
      await context.deps.store.commitProcessIdentity({
        sessionId,
        fence,
        process: acquired.process,
        now: context.now()
      })
    } else if (!isDeepStrictEqual(record.lease.ownerProcess, acquired.process)) {
      throw new Error('agent_session_ownership_unknown')
    }
    return {
      record: await context.deps.store.proveOwner({
        sessionId,
        fence,
        link: acquired.link,
        now: context.now(),
        ...(options ? { options } : {})
      }),
      acquisitionGeneration: acquired.acquisitionGeneration ?? null
    }
  } catch (error) {
    if (isAgentSessionPreSpawnError(error)) {
      throw error
    }
    return rethrowAfterAgentSessionAcquisitionCleanup(context.deps.adapter, sessionId, error)
  }
}
