import type { AgentSessionConversationCommandResult } from '../../../shared/agent-session/agent-session-conversation-command'
import {
  agentSessionFailureFact,
  readAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  runStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
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
import {
  runAfterRewindStart,
  type ReadyOperationSelection
} from './structured-agent-session-ready-operation'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'
import {
  conversationCommandFailure,
  type ConversationCommandParams
} from './structured-conversation-command'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import { maybeQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import { structuredAgentSessionCompactBody } from './structured-agent-session-command-turn'

/** RPC success means handed over, not finished; queued commands answer immediately as cards. */
export async function runStructuredCompaction(
  context: StructuredAgentSessionMutationContext,
  host: Pick<StructuredAgentSessionHost, 'waitForSendSettlement'>,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams,
  arrival: { clearInFlight?: boolean } = {}
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult>> {
  const { sessionId, clientOperationId } = params.envelope
  // Legacy operation records must replay rather than execute again.
  const priorRecord = (): AgentSessionConversationCommandResult | null => {
    const prior = context.deps.store.getConversation(sessionId)?.conversationCommand
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
  const accepted = await acceptStructuredConversationCommand(
    context,
    caller,
    params,
    priorRecord,
    arrival
  )
  if (!accepted.ok) {
    return accepted
  }
  if ('recorded' in accepted.value) {
    return { ...accepted, value: accepted.value.recorded }
  }
  if ('queued' in accepted.value) {
    // Queued cards own any later refusal feedback.
    return {
      ...accepted,
      value: { command: 'compact', state: 'completed', queued: accepted.value.queued }
    }
  }
  const settled = await host.waitForSendSettlement(sessionId, accepted.value.clientMessageId, {
    until: 'handed-over',
    budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
  })
  return {
    ...accepted,
    ...(settled ? { cursor: settled.cursor } : {}),
    value: compactionReply(
      settled && 'submission' in settled.value ? settled.value.submission : undefined,
      {
        ...structuredAgentSessionFailureWordsContext(context.deps.store.getConversation(sessionId)),
        command: 'compact'
      }
    )
  }
}

/** Legacy completed replies now mean the command started. */
function compactionReply(
  submission: AgentJournalSubmission | undefined,
  context: AgentSessionFailureWordsContext
): AgentSessionConversationCommandResult {
  const error = (reason: string | null, fallback: string) => (reason ?? fallback).slice(0, 4096)
  if (!submission || isQueuedAgentJournalSubmission(submission)) {
    return { command: 'compact', state: 'unknown', error: 'The command has not started yet.' }
  }
  if (submission.dispatchState === 'rejected') {
    // Preserve legacy row reasons when no structured failure fact exists.
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

function acceptStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams,
  priorRecord: () => AgentSessionConversationCommandResult | null,
  arrival: { clearInFlight?: boolean }
): Promise<AgentSessionMutationResult<ConversationCommandAcceptance>> {
  const plan = conversationCommandPlan({
    envelope: params.envelope,
    ...(params.delivery ? { delivery: params.delivery } : {}),
    priorRecord
  })
  return runAfterRewindStart(context, caller.callerKey, params.envelope, plan, (selection) =>
    acceptUnderSerialize(context, caller, params, plan, arrival, selection)
  )
}

function acceptUnderSerialize(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams,
  plan: ReturnType<typeof conversationCommandPlan>,
  arrival: { clearInFlight?: boolean },
  selection: ReadyOperationSelection
): Promise<AgentSessionMutationResult<ConversationCommandAcceptance>> {
  return runStructuredAgentSessionMutation(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      run: async (ctx) => {
        // Queue first so commands obey the same holds as sends before active-work admission.
        const queued = await maybeQueueStructuredAgentSessionSend(context, ctx, {
          envelope: params.envelope,
          body: structuredAgentSessionCompactBody(),
          ...(params.userSend ? { userSend: params.userSend } : {}),
          ...(params.delivery ? { delivery: params.delivery } : {})
        })
        if (queued && !queued.ok) {
          return queued
        }
        if (queued) {
          const { value } = queued
          return {
            ok: true,
            value:
              'queued' in value
                ? { queued: value.queued }
                : { clientMessageId: value.submission.clientMessageId }
          }
        }
        const record = context.deps.store.requireWritableRecord(ctx.sessionId)
        const refusal =
          record &&
          conversationCommandBlocked(
            ctx,
            record,
            {
              views: context.readChildWork(ctx.sessionId),
              open: context.childWorkOpen(ctx.sessionId)
            },
            context.sessions.get(ctx.sessionId)?.child ? undefined : 'at-rest'
          )
        const blocked =
          structuredAgentSessionSendBlock(record) ??
          (refusal ? { ok: false as const, refusal } : null)
        if (blocked) {
          return blocked
        }
        return plan.run(ctx)
      }
    },
    sendPreparation(context, params.envelope, arrival, selection)
  )
}
