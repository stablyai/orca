// The host's half of a TUI-to-native handoff acquiring its native child.
//
// Like attach, the new child writes through a sink this attempt owns: only a proven owner makes it
// the session's, so a failed acquire takes whatever its child queued with it instead of leaving it
// in the session's sink for the next drain to wait on.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { journalIdentityFor } from './structured-agent-session-attach'
import { rethrowAfterAgentSessionAcquisitionCleanup } from './structured-agent-session-adapter'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import type { HostHandoffAccess } from './structured-agent-session-host-handoff'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import { adapterSupportsCreateIfDeclared } from './structured-agent-session-provider-support'

export async function acquireNativeHandoffOwner(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess,
  input: { sessionId: string; fence: number; spawnToken: string }
): Promise<AgentSessionRecord> {
  const session = host.session(input.sessionId)
  const record = deps.store.getRecord(input.sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  // Native handoff bypasses attach admission; reject before unbinding TUI ownership.
  if (!adapterSupportsCreateIfDeclared(deps.adapter, record.location, record.provider)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const priorSink = host.eventSinks.eventSinkFor(input.sessionId)
  const priorBarrier = await priorSink.drained()
  if (!priorBarrier.ok) {
    throw priorBarrier.error
  }
  priorSink.unbind()
  // The new child writes through a sink this attempt owns; only a proven owner makes it the
  // session's, so a failed acquire takes whatever its child queued with it.
  const eventSink = host.eventSinks.mintEventSink(input.sessionId)
  let adopted = false
  try {
    return await proveNativeHandoffOwner(
      deps,
      host,
      { ...input, session, record },
      eventSink,
      () => {
        host.eventSinks.adoptEventSink(input.sessionId, eventSink)
        adopted = true
      }
    )
  } finally {
    if (!adopted) {
      eventSink.close()
    }
  }
}

async function proveNativeHandoffOwner(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess,
  input: {
    sessionId: string
    fence: number
    spawnToken: string
    session: StructuredAgentSessionHostSession
    record: AgentSessionRecord
  },
  eventSink: DeferredStructuredAgentSessionEventSink,
  adopt: () => void
): Promise<AgentSessionRecord> {
  const { session, record } = input
  // Recheck immediately before acquisition; capability probes may drift while
  // the old TUI event sink is draining.
  if (!adapterSupportsCreateIfDeclared(deps.adapter, record.location, record.provider)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const acquired = await deps.adapter.acquire({
    identity: journalIdentityFor(record, session.params),
    fence: input.fence,
    spawnToken: input.spawnToken,
    ...(record.options ? { options: record.options } : {}),
    events: eventSink.sink
  })
  let proved: AgentSessionRecord
  try {
    // A starting child has proven nothing yet: the record keeps the saved options as intent, and
    // the `started` event persists what the child reports.
    const options =
      acquired.providerChildPhase === 'starting'
        ? undefined
        : await readNativeSessionOptions({
            adapter: deps.adapter,
            sessionId: input.sessionId,
            fence: input.fence,
            ...(record.options ? { priorOptions: record.options } : {})
          })
    await deps.store.commitProcessIdentity({
      sessionId: input.sessionId,
      fence: input.fence,
      process: acquired.process,
      now: host.now()
    })
    proved = await deps.store.proveOwner({
      sessionId: input.sessionId,
      fence: input.fence,
      link: acquired.link,
      now: host.now(),
      ...(options ? { options } : {})
    })
  } catch (error) {
    return rethrowAfterAgentSessionAcquisitionCleanup(deps.adapter, input.sessionId, error)
  }
  session.hasProviderChild = true
  session.providerChildPhase = acquired.providerChildPhase ?? 'ready'
  host.publishStatus?.(input.sessionId)
  session.fence = proved.lease.runtimeFence
  // A handoff moved the fence, not a restart: no writer is rebased across it.
  delete session.resumedFromFence
  session.acquisitionGeneration = acquired.acquisitionGeneration ?? null
  adopt()
  eventSink.bind({
    journal: session.journal,
    fence: proved.lease.runtimeFence,
    publish: (activity) => host.subscribers.publish(input.sessionId, session.journal, activity)
  })
  const acquiredBarrier = await eventSink.drained()
  if (!acquiredBarrier.ok) {
    throw acquiredBarrier.error
  }
  host.subscribers.snapshot(input.sessionId, session.journal, proved.lease.runtimeFence)
  return proved
}
