// `/compact` sent through the command RPC: accepted into the conversation as the user's message,
// and answered once the delivery loop hands it over.

import type { AgentSessionConversationCommandResult } from '../../../shared/agent-session-conversation-command'
import {
  agentSessionFailureFact,
  readAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  mutateStructuredAgentSession,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  conversationCommandPlan,
  type ConversationCommandAcceptance
} from './structured-agent-session-mutation-plans'
import {
  sendPreparation,
  structuredAgentSessionFailureWordsContext,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import {
  conversationCommandFailure,
  type ConversationCommandParams
} from './structured-conversation-command'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

/**
 * `/compact` from a client that asks through the command RPC: accepted into the conversation like
 * any message, and answered once it is handed over — the command has started, not finished. Its
 * end reaches the chat as its own turn and result row.
 */
export async function runStructuredCompaction(
  context: StructuredAgentSessionMutationContext,
  host: Pick<StructuredAgentSessionHost, 'waitForSendSettlement'>,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult>> {
  const { sessionId, clientOperationId } = params.envelope
  // An older build ran this operation id and recorded it on the session: answered, never rerun.
  const priorRecord = (): AgentSessionConversationCommandResult | null => {
    const prior = context.deps.store.getRecord(sessionId)?.conversationCommand
    if (prior?.operationId !== clientOperationId || prior.callerKey !== caller.callerKey) {
      return null
    }
    return prior.phase === 'committed'
      ? prior
      : {
          command: 'compact',
          state: 'unknown',
          ...conversationCommandFailure(agentSessionFailureFact('compactionUnconfirmed'))
        }
  }
  const accepted = await acceptStructuredConversationCommand(context, caller, params, priorRecord)
  if (!accepted.ok) {
    return accepted
  }
  if ('recorded' in accepted.value) {
    return { ...accepted, value: accepted.value.recorded }
  }
  const settled = await host.waitForSendSettlement(sessionId, accepted.value.clientMessageId, {
    until: 'handed-over',
    budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
  })
  return {
    ...accepted,
    ...(settled ? { cursor: settled.cursor } : {}),
    // A /compact is a command send, never a queued draft, so its settlement always carries the submission.
    value: compactionReply(
      settled && 'submission' in settled.value ? settled.value.submission : undefined,
      {
        ...structuredAgentSessionFailureWordsContext(context.deps.store.getRecord(sessionId)),
        command: 'compact'
      }
    )
  }
}

/** The reply shape clients already read: `completed` is now "started". */
function compactionReply(
  submission: AgentJournalSubmission | undefined,
  context: AgentSessionFailureWordsContext
): AgentSessionConversationCommandResult {
  const error = (reason: string | null, fallback: string) => (reason ?? fallback).slice(0, 4096)
  if (!submission || isQueuedAgentJournalSubmission(submission)) {
    return { command: 'compact', state: 'unknown', error: 'The command has not started yet.' }
  }
  if (submission.dispatchState === 'rejected') {
    // The message's own fact, in the words its row shows; a row from an older host keeps its reason.
    const rejection = readAgentSessionFailureFact(submission.rejection)
    return rejection
      ? {
          command: 'compact',
          state: 'completed',
          ...conversationCommandFailure(rejection, context)
        }
      : {
          command: 'compact',
          state: 'completed',
          error: error(submission.reason, 'The command was not run.')
        }
  }
  return submission.dispatchState === 'unknown'
    ? {
        command: 'compact',
        state: 'unknown',
        error: error(submission.reason, 'The command may not have run.')
      }
    : { command: 'compact', state: 'completed' }
}

/** A conversation command, accepted into the queue as the user's message. */
function acceptStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope },
  priorRecord: () => AgentSessionConversationCommandResult | null
): Promise<AgentSessionMutationResult<ConversationCommandAcceptance>> {
  const plan = conversationCommandPlan({ envelope: params.envelope, priorRecord })
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      run: async (ctx) => {
        const record = context.deps.store.getRecord(ctx.sessionId)
        const refusal =
          record &&
          conversationCommandBlocked(
            ctx,
            record,
            context.sessions.get(ctx.sessionId)?.child ? undefined : 'at-rest'
          )
        const blocked =
          structuredAgentSessionSendBlock(record) ??
          (refusal ? { ok: false as const, refusal } : null)
        if (blocked) {
          return blocked
        }
        const accepted = await plan.run(ctx)
        if (accepted.ok) {
          context.wakeDelivery(ctx.sessionId)
        }
        return accepted
      }
    },
    sendPreparation(context, params.envelope)
  )
}
