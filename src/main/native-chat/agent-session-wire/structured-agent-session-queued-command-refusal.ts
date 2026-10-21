// A queued command card's refusal at hand-over: nobody waits on it, so its own turn says why.

import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import { structuredAgentSessionCommandTurn } from '../../../shared/structured-agent-session-command-turn-identity'
import type { StructuredAgentSessionCommandHandoverContext } from './structured-agent-session-command-turn'

/**
 * A queued command refused before it was handed over. Nothing reached the provider, so no hand-off
 * is recorded: the ended turn and its row land in one batch, then the submission is rejected while
 * still queued. A crash between leaves a queued submission, which a restart returns to waiting;
 * never a card gone with no row, nor a command that may have run.
 */
export async function refuseQueuedCommand(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission,
  fact: SubmissionRejectionFact,
  refused: { state: 'rejected' } & AgentJournalDispatchRejection,
  command: AgentSessionConversationCommand
): Promise<void> {
  const { clientMessageId } = submission
  const turn = structuredAgentSessionCommandTurn(clientMessageId)
  const now = ctx.now()
  await ctx.journal.appendLifecycleBatch({
    settlementId: `command-settled:${clientMessageId}`,
    fence: ctx.fence,
    mutations: [
      {
        kind: 'item',
        identity: turn.identity,
        body: agentJournalTurnBody({
          turnId: turn.turnId,
          state: 'completed',
          outcome: 'failure',
          userItemId: agentJournalSubmissionKey(clientMessageId),
          requestedAt: submission.submittedAt,
          startedAt: now,
          completedAt: now
        }),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      },
      {
        kind: 'item',
        identity: turn.resultIdentity,
        body: {
          kind: 'status',
          ...agentSessionFailureWords(fact, {
            ...ctx.failureTextContext,
            command,
            surface: 'row'
          }),
          tone: 'error'
        },
        turnScope: { kind: 'turn', turnItemId: turn.itemId }
      }
    ]
  })
  await ctx.journal.resolveDispatch({ clientMessageId, ...refused, fence: ctx.fence })
}
