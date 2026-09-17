import type { AgentSessionConversationCommandResult } from '../../../shared/agent-session-conversation-command'
import type {
  ConversationCommandParams,
  PreparedConversationCommand
} from './structured-conversation-command'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

export const COMPACTION_UNCONFIRMED = 'Compaction completion is unconfirmed.'
export const CONVERSATION_COMMAND_ABANDONED =
  'Conversation operation was interrupted before completion.'

export type ConversationCommandLifecycleState =
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'unverifiable'

export async function publishConversationCommandLifecycle(input: {
  context: () => StructuredAgentSessionMutationContext
  command: ConversationCommandParams['command']
  operationId: string
  execution: PreparedConversationCommand
  value: AgentSessionConversationCommandResult
  state: ConversationCommandLifecycleState
}): Promise<void> {
  const { command, context, execution, operationId, state, value } = input
  const turnId = `${command}:${operationId}`
  const text =
    state === 'running'
      ? value.error
        ? command === 'compact'
          ? COMPACTION_UNCONFIRMED
          : 'Conversation clear completion is unconfirmed.'
        : command === 'compact'
          ? 'Compacting conversation…'
          : 'Clearing conversation…'
      : state === 'unverifiable'
        ? command === 'compact'
          ? COMPACTION_UNCONFIRMED
          : 'Conversation clear completion is unconfirmed.'
        : (value.error ??
          (command === 'compact' ? 'Conversation compacted.' : 'Conversation cleared.'))
  await execution.turn.journal.appendItem(
    { provider: 'orca', clientMessageId: turnId },
    {
      kind: 'status',
      text,
      turnLifecycle: {
        turnId,
        state,
        ...(state === 'running' ? { startedAt: context().now() } : { completedAt: context().now() })
      }
    },
    { fence: execution.turn.fence }
  )
  execution.turn.publish()
}
