import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { sendPreparation } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
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

/** A command's `error` is the sentence its row shows. */
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
  /** /compact only: wait as a card while the agent works, as a queued send does. */
  delivery?: 'queue-if-active'
  /** Host-local, set by the client-facing command RPC as for an ordinary send. */
  userSend?: true
}
/** Stop the provider and record a fresh-context boundary in the same conversation. */
export function runStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
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
  return context.serialize(sessionId, async () => {
    let clear: AgentSessionConversationClear | null = null
    const result = await admitAndRunAgentSessionMutation({
      store,
      adapter: context.deps.adapter,
      agents: context.deps.agents,
      logger: context.deps.logger,
      callerKey: caller.callerKey,
      envelope,
      // Starts the agent only to settle a rewind in doubt, as a send does; a /clear itself starts nothing.
      prepareSession: sendPreparation(context, envelope, { refusesInRun: true }),
      journal: () => context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
      now: context.now,
      plan: {
        method: 'agentSession.conversationCommand',
        fields: { command },
        // Written to the conversation, not the agent, so whoever owns the agent does not matter.
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
        // The commit is the only write, so a clear with no committed answer changed nothing.
        rerunWhenReplayMissing: () => true,
        run: async (ctx) => {
          const record = store.getRecord(sessionId)!
          const blocked = conversationCommandBlocked(
            ctx,
            record,
            context.readChildWork(sessionId),
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
            context.readChildWork(sessionId),
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
            ctx.operationReceipt,
            agentSessionOperationKey(caller.callerKey, clientOperationId)
          )
          return { ok: true, value: completed }
        }
      }
    })
    return result.ok &&
      'runtimeFence' in result.value &&
      typeof result.value.runtimeFence === 'number'
      ? { ...result, fence: result.value.runtimeFence }
      : result
  })
}
