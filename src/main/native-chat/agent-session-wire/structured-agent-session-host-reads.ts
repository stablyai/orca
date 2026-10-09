import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessagesPageRequest,
  AgentSessionQueuedMessageReadRequest,
  AgentSessionSlashCommand
} from '../../../shared/agent-session-wire'
import { readQueuedMessagesPage } from './structured-agent-session-queue-page'
import { readQueuedMessageBody } from './structured-agent-session-queue-body'
import { structuredQueueSendGate } from './structured-agent-session-queued-publication'
import { structuredAgentSessionOwnerStatus } from './structured-agent-session-owner-status'
import type { QueueReplyEnvelope } from './agent-session-queue-reply-budget'
import type { StructuredAgentSessionBackgroundTaskChannel } from './structured-agent-session-background-task-channel'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export function structuredAgentSessionHostReads(
  context: () => {
    deps: StructuredAgentSessionHostDeps
    conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
    backgroundTasks: StructuredAgentSessionBackgroundTaskChannel
    readCommands: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  }
) {
  return {
    readCommands: (sessionId: string) => ({ commands: context().readCommands(sessionId) }),
    handoffStatus: (sessionId: string) =>
      structuredAgentSessionOwnerStatus(context().deps, sessionId),
    history: (...args: Parameters<StructuredAgentSessionBackgroundTaskChannel['history']>) =>
      context().backgroundTasks.history(...args),
    journalSnapshot: async (sessionId: string): Promise<AgentJournalSnapshot> =>
      (await context().conversation(sessionId)).journal.snapshot(),
    subscribe: (...args: Parameters<StructuredAgentSessionBackgroundTaskChannel['subscribe']>) =>
      context().backgroundTasks.subscribe(...args),
    queuedMessagesPage: async (
      request: AgentSessionQueuedMessagesPageRequest,
      envelope?: QueueReplyEnvelope
    ) => {
      const { conversation, deps } = context()
      return readQueuedMessagesPage(
        (await conversation(request.sessionId)).journal,
        structuredQueueSendGate(deps.store, request.sessionId),
        request,
        envelope
      )
    },
    queuedMessageRead: async (
      request: AgentSessionQueuedMessageReadRequest,
      envelope?: QueueReplyEnvelope
    ) => {
      const { conversation, deps } = context()
      return readQueuedMessageBody(
        (await conversation(request.sessionId)).journal,
        structuredQueueSendGate(deps.store, request.sessionId),
        request,
        envelope
      )
    }
  }
}
