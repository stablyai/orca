import { createStructuredAgentSessionWorkspaceSleeper } from './structured-agent-session-workspace-sleep'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredConversationCommandController } from './structured-conversation-command-controller'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import { structuredAgentSessionConversationClosable } from './structured-agent-session-host-lifetime'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation,
  type AgentSessionLease
} from '../../../shared/agent-session/lifecycle/agent-session-record'
import { isProvenDeadProbe } from '../../../shared/agent-session/lifecycle/agent-session-lease-adjudication'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'

type WorkspaceRebindContext = {
  deps: ReturnType<Parameters<typeof createStructuredAgentSessionWorkspaceSleeper>[0]>['deps']
  runtimeState: Pick<
    StructuredAgentSessionHostRuntimeState,
    'reconcileLeases' | 'probeRecord' | 'startFlights'
  >
  tasks: Pick<StructuredAgentSessionTaskQueue, 'serialize'>
  sessions: Pick<StructuredAgentSessionConversations, 'get'>
  commands: Pick<StructuredConversationCommandController, 'pending'>
  lifetime: Pick<StructuredAgentSessionConversationLifetime, 'closeConversation'>
  now: () => number
}

const leaseHeld = (lease: AgentSessionLease): boolean =>
  lease.claimStatus !== 'released' || lease.ownerProcess !== null

export function createStructuredSessionWorkspaceActions(
  context: () => WorkspaceRebindContext &
    ReturnType<Parameters<typeof createStructuredAgentSessionWorkspaceSleeper>[0]>
) {
  return {
    sleepWorkspace: createStructuredAgentSessionWorkspaceSleeper(context),
    rebindWorkspace: createStructuredSessionWorkspaceRebinder(context)
  }
}

function createStructuredSessionWorkspaceRebinder(context: () => WorkspaceRebindContext) {
  return async (
    sessionId: string,
    original: AgentSessionExecutionLocation,
    location: AgentSessionExecutionLocation,
    check: () => void
  ): Promise<void> => {
    const { deps, runtimeState, tasks, sessions, commands, lifetime, now } = context()
    const reconciliation = await runtimeState.reconcileLeases(sessionId)
    if (reconciliation) {
      throw new AgentSessionRefusalError(reconciliation)
    }
    await tasks.serialize(sessionId, async () => {
      const session = sessions.get(sessionId)
      const working = () =>
        commands.pending.has(sessionId) ||
        runtimeState.startFlights.has(sessionId) ||
        (session !== undefined && !structuredAgentSessionConversationClosable(session))
      // Restart evidence goes stale: an owner no work here explains is probed afresh, and only
      // one proven gone is evicted, at the fence it was probed under.
      const held = deps.store.getRecord(sessionId)
      if (held && leaseHeld(held.lease) && !working()) {
        const probe = await runtimeState.probeRecord(held)
        if (
          !working() &&
          (isProvenDeadProbe(probe) ||
            (held.lease.ownerProcess === null && probe.outcome === 'reservation-unused'))
        ) {
          // A lease that moved since the probe is refused below like any other held lease.
          await deps.store
            .evictProvenDeadOwner({
              sessionId,
              expectedFence: held.lease.runtimeFence,
              probe,
              now: now()
            })
            .catch((error: unknown) => {
              if (!isAgentSessionRefusalError(error)) {
                throw error
              }
            })
        }
      }
      await deps.store.rebindWorkspace(sessionId, original, location, (record) => {
        check()
        // Refuse only live work. Rewinds and commands run in this session lane, so a saved
        // in-doubt rewind or legacy command result is history; the open that follows settles it.
        if (record.lease.unreconciled || leaseHeld(record.lease) || working()) {
          throw agentSessionRefusalError('agent_session_operation_unknown', {})
        }
      })
      if (session && !agentSessionExecutionLocationsEqual(session.params.location, location)) {
        await lifetime.closeConversation(sessionId)
      }
    })
  }
}
