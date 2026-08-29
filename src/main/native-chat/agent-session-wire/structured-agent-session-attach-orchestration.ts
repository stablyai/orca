// The host's attach, lifted out of the host class.
//
// Attach is the one operation that touches every collaborator the host owns — the lease
// reconciler, the recovery resolver, the event sink, the journal, the subscriber set and the task
// queue — so leaving it inline made the host grow every time any of them did. The host keeps the
// state; this owns the ordering between them.

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'

export function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const attaching = context.serialize(sessionId, async () => {
    const unreconciled = await context.reconcileLeases(sessionId)
    if (unreconciled) {
      return refuseAgentSessionMutation(unreconciled)
    }
    await context.runtimeState.resolveRecovery(sessionId)
    const eventSink = context.runtimeState.eventSinkFor(sessionId)
    const attached = await performAttach({
      store: context.deps.store,
      adapter: context.deps.adapter,
      journalRoot: context.deps.journalRoot,
      eventSink: eventSink.sink,
      onAcquiring: () => eventSink.unbind(),
      beforeJournalOpen: async () => {
        eventSink.unbind()
        await eventSink.drained()
      },
      authority: {
        spawnToken: () => context.deps.mintSpawnToken?.() ?? randomUUID(),
        claimKeyId: context.deps.claimKeyId,
        handoffOperationId: params.envelope.clientOperationId,
        probe: await context.runtimeState.probeOwner(sessionId),
        ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
        ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params))
      },
      callerKey,
      params,
      now: () => context.now(),
      onAttachFailed: () => {
        context.sessions.delete(sessionId)
        eventSink.close()
        context.runtimeState.discardEventSink(sessionId)
      },
      onAttached: (attached) => {
        const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
        const previousFence = context.sessions.get(sessionId)?.fence
        context.sessions.set(sessionId, {
          journal: attached.journal,
          params,
          fence,
          hasProviderChild: true
        })
        if (attached.recovery) {
          context.subscribers.reset(sessionId, attached.journal, attached.recovery.reset, fence)
        } else if (previousFence !== undefined && previousFence !== fence) {
          context.subscribers.snapshot(sessionId, attached.journal, fence)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
        eventSink.bind({
          journal: attached.journal,
          fence,
          publish: () => context.subscribers.publish(sessionId, attached.journal)
        })
      }
    })
    // Why: a failed attach that left no session behind must not strand a bound sink; the runtime
    // caches one per session id and would hand this same closed instance to the next attempt.
    if (!attached.ok && !context.sessions.has(sessionId)) {
      eventSink.close()
      context.runtimeState.discardEventSink(sessionId)
    }
    return attached
  })
  return context.tasks.trackAttach(attaching)
}
