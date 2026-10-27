import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessageMoveAnchor,
  AgentSessionQueuedMessageMoveResult
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { mutateQueued } from './structured-agent-session-queued-mutations'

/** The saved result spends a move even after compaction, so replay never moves a card twice. */
export function moveQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    messageId: string
  } & AgentSessionQueuedMessageMoveAnchor
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessageMoveResult>> {
  const { envelope, ...fields } = params
  return mutateQueued(context, caller, envelope, {
    method: 'agentSession.queuedMessageMove',
    fields,
    conversationWrite: true,
    commandReceipt: {
      result: () => ({
        kind: 'no-op',
        outcome: { kind: 'queue-move', messageId: params.messageId, status: 'moved' }
      }),
      unwritten: (value) => ({ kind: 'no-op', outcome: { kind: 'queue-move', ...value } })
    },
    run: async (ctx) => ({
      ok: true,
      value: await ctx.journal.queuedMessages.move(fields, ctx.operationReceipt)
    }),
    replay: (_ctx, _outcome, receipt) =>
      receipt?.kind === 'no-op' && receipt.outcome.kind === 'queue-move'
        ? { messageId: receipt.outcome.messageId, status: receipt.outcome.status }
        : null
  })
}
