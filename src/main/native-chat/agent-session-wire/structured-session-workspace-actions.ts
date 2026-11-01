import { createStructuredAgentSessionWorkspaceSleeper } from './structured-agent-session-workspace-sleep'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredConversationCommandController } from './structured-conversation-command-controller'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import { structuredAgentSessionConversationClosable } from './structured-agent-session-host-lifetime'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'

type WorkspaceRebindContext = {
  deps: ReturnType<Parameters<typeof createStructuredAgentSessionWorkspaceSleeper>[0]>['deps']
  runtimeState: Pick<StructuredAgentSessionHostRuntimeState, 'reconcileLeases'>
  tasks: Pick<StructuredAgentSessionTaskQueue, 'serialize'>
  sessions: Pick<StructuredAgentSessionConversations, 'get'>
  commands: Pick<StructuredConversationCommandController, 'pending'>
  lifetime: Pick<StructuredAgentSessionConversationLifetime, 'closeConversation'>
}

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
    const { deps, runtimeState, tasks, sessions, commands, lifetime } = context()
    const reconciliation = await runtimeState.reconcileLeases(sessionId)
    if (reconciliation) {
      throw new AgentSessionRefusalError(reconciliation)
    }
    await tasks.serialize(sessionId, async () => {
      const session = sessions.get(sessionId)
      await deps.store.rebindWorkspace(sessionId, original, location, (record) => {
        check()
        // Refuse only live work. Rewinds and commands run in this session lane, so a saved
        // in-doubt rewind or legacy command result is history; the open that follows settles it.
        if (
          record.lease.unreconciled ||
          record.lease.claimStatus !== 'released' ||
          record.lease.ownerProcess ||
          commands.pending.has(sessionId) ||
          (session && !structuredAgentSessionConversationClosable(session))
        ) {
          throw agentSessionRefusalError('agent_session_operation_unknown', {})
        }
      })
      if (session && !agentSessionExecutionLocationsEqual(session.params.location, location)) {
        await lifetime.closeConversation(sessionId)
      }
    })
  }
}
