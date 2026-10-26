import { neverThrowingStructuredAgentSessionLogger } from './structured-agent-session-logger'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session/agent-session-conversation-command'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { sendPreparation } from './structured-agent-session-send-preparation'
import {
  runAfterRewindStart,
  type ReadyOperationSelection
} from './structured-agent-session-ready-operation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  providerContextBoundaryForClear,
  type AgentSessionConversationClear
} from '../../runtime/agent-session-conversation-command-record'

export function conversationCommandFailure(
  failure: AgentSessionFailureFact | undefined,
  context: AgentSessionFailureWordsContext = {}
) {
  if (!failure) {
    return {}
  }
  const words = agentSessionFailureWords(failure, { ...context, surface: 'row' })
  return { error: words.text, failure: words.failure }
}

export type ConversationCommandParams = {
  envelope: AgentSessionMutationEnvelope
  command: AgentSessionConversationCommand
  /** Only /compact queues: the drain delivers provider messages; /clear needs host-side execution. */
  delivery?: 'queue-if-active'
  userSend?: true
}
export function runStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult>> {
  return runAfterRewindStart(
    context,
    caller.callerKey,
    params.envelope,
    { method: 'agentSession.conversationCommand', fields: { command: params.command } },
    (selection) => clearUnderSerialize(context, caller, params, selection)
  )
}

async function clearUnderSerialize(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams,
  selection: ReadyOperationSelection
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult>> {
  const { envelope, command } = params
  const { sessionId, clientOperationId } = envelope
  const store = context.deps.store
  const matching = () => {
    const record = store.getRecord(sessionId)?.conversationCommand
    return record?.operationId === clientOperationId && record.callerKey === caller.callerKey
      ? record
      : null
  }
  let clear: AgentSessionConversationClear | null = null
  const result = await admitAndRunAgentSessionMutation({
    store,
    adapter: context.deps.adapter,
    agents: context.deps.agents,
    logger: context.deps.logger,
    callerKey: caller.callerKey,
    envelope,
    // /clear starts nothing unless an ambiguous rewind needs settlement first.
    prepareSession: sendPreparation(context, envelope, { refusesInRun: true }, selection),
    journal: () => context.sessions.get(sessionId)?.journal,
    currentWork: () =>
      hostStructuredAgentSessionCurrentWork({ store, sessions: context.sessions }, sessionId),
    publish: (journal) => context.publish(sessionId, journal),
    now: context.now,
    plan: {
      method: 'agentSession.conversationCommand',
      fields: { command },
      // This writes the conversation independently of provider ownership.
      conversationWrite: true,
      recoverUnknownFromDurableState: true,
      settlesWithWrite: true,
      successReceipt: () =>
        store.conversationReceipts.clear(
          () => {
            if (!clear) {
              throw new Error('agent_session_clear_not_completed')
            }
            return clear
          },
          { callerKey: caller.callerKey, operationId: clientOperationId }
        ),
      replay: (_ctx, outcome) => {
        if (outcome.status === 'succeeded' && outcome.conversationCommand) {
          return outcome.conversationCommand
        }
        const prior = matching()
        return prior?.phase === 'committed' ? prior : null
      },
      // No committed clear means no effects, so replay can safely rerun it.
      rerunWhenReplayMissing: () => true,
      run: async (ctx) => {
        const record = store.getRecord(sessionId)!
        const blocked = conversationCommandBlocked(
          ctx,
          record,
          { views: context.readChildWork(sessionId), open: context.childWorkOpen(sessionId) },
          context.sessions.get(sessionId)?.child ? undefined : 'at-rest'
        )
        if (blocked) {
          return { ok: false, refusal: blocked }
        }
        await context.stopAgent(sessionId, { cause: 'context-clear' })
        const stopped = store.getRecord(sessionId)!
        const fence = stopped.lease.runtimeFence
        const rechecked = conversationCommandBlocked(
          { ...ctx, fence },
          stopped,
          { views: context.readChildWork(sessionId), open: context.childWorkOpen(sessionId) },
          'at-rest'
        )
        if (rechecked) {
          return { ok: false, refusal: rechecked }
        }
        const completed: AgentSessionConversationClear['command'] = {
          command: 'clear',
          runtimeFence: fence,
          operationId: clientOperationId,
          callerKey: caller.callerKey,
          phase: 'committed',
          state: 'completed'
        }
        clear = { sessionId, fence, command: completed, now: context.now() }
        if (!ctx.operationReceipt) {
          throw new Error('agent_session_clear_receipt_missing')
        }
        await ctx.journal.context.clear(
          providerContextBoundaryForClear(clear),
          ctx.operationReceipt
        )
        return { ok: true, value: completed }
      }
    }
  })
  if (result.ok && command === 'clear') {
    try {
      context.publishConversationName?.(sessionId)
    } catch (error) {
      neverThrowingStructuredAgentSessionLogger(context.deps.logger).warn(
        'Chat name publication failed',
        { scope: 'conversation-name', sessionId, error }
      )
    }
  }
  return result.ok &&
    'runtimeFence' in result.value &&
    typeof result.value.runtimeFence === 'number'
    ? { ...result, fence: result.value.runtimeFence }
    : result
}
