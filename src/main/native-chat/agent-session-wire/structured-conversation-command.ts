import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedSendReceipt
} from '../../../shared/agent-session-wire'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { sendPreparation } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  clearConversationUnderSerialize,
  structuredAgentSessionClearBody
} from './structured-conversation-clear'
import { maybeQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
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
  /** Wait as a card while the agent works, as a queued send does. */
  delivery?: 'queue-if-active'
  /** Host-local, set by the client-facing command RPC as for an ordinary send. */
  userSend?: true
}
/** A /clear waiting as a card answers at once; the card is the one surface from here. */
function queuedClearAnswer(
  queued: AgentSessionQueuedSendReceipt
): AgentSessionConversationCommandResult {
  return { command: 'clear', state: 'completed', queued }
}

/** Stop the provider and record a fresh-context boundary in the same conversation; asked with
 *  `delivery` while the agent works, wait as a /clear card the queue runs when its turn comes. */
export function runStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult>> {
  const { envelope, command, delivery } = params
  const { sessionId, clientOperationId } = envelope
  const store = context.deps.store
  const operation = { callerKey: caller.callerKey, operationId: clientOperationId }
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
        fields: { command, ...(delivery ? { delivery } : {}) },
        // Written to the conversation, not the agent, so whoever owns the agent does not matter.
        conversationWrite: true,
        recoverUnknownFromDurableState: true,
        settlesWithWrite: true,
        // The clear's own record write, or for a card, the ledger's plain acceptance.
        successReceipt: () => {
          const cleared = store.conversationReceipts.clear(() => {
            if (!clear) {
              throw new Error('agent_session_clear_not_completed')
            }
            return clear
          }, operation)
          const queued = store.operationOutcomeReceipt({
            ...operation,
            outcome: { status: 'succeeded', sessionId }
          })
          return {
            write: (db) => (clear ? cleared : queued).write(db),
            committed: () => (clear ? cleared : queued).committed()
          }
        },
        replay: (ctx, outcome) => {
          if (outcome.status === 'succeeded' && outcome.conversationCommand) {
            return outcome.conversationCommand
          }
          // A card answers from itself; one pruned after it ran or was deleted, as withdrawn.
          if (delivery) {
            const card = queuedSendAnswer(ctx.journal, clientOperationId)
            if (card && 'queued' in card) {
              return queuedClearAnswer(card.queued)
            }
            if (outcome.status === 'succeeded') {
              return queuedClearAnswer({
                messageId: clientOperationId,
                position: 0,
                state: 'withdrawn'
              })
            }
          }
          const prior = matching()
          return prior?.phase === 'committed' ? prior : null
        },
        // The commit is the only write, so a clear with no committed answer changed nothing.
        rerunWhenReplayMissing: () => true,
        run: async (ctx) => {
          // The queue's own accept rule decides first, as for /compact: whatever a queued send
          // waits behind, the /clear waits behind too, and the queue runs it when its turn comes.
          const card = await maybeQueueStructuredAgentSessionSend(context, ctx, {
            envelope,
            body: structuredAgentSessionClearBody(),
            ...(params.userSend ? { userSend: params.userSend } : {}),
            ...(delivery ? { delivery } : {})
          })
          if (card && !card.ok) {
            return card
          }
          if (card && 'queued' in card.value) {
            return { ok: true, value: queuedClearAnswer(card.value.queued) }
          }
          return clearConversationUnderSerialize(context, ctx, operation, (completed) => {
            clear = completed
            if (!ctx.operationReceipt) {
              throw new Error('agent_session_clear_receipt_missing')
            }
            return ctx.journal.context.clear(
              providerContextBoundaryForClear(completed),
              ctx.operationReceipt,
              agentSessionOperationKey(caller.callerKey, clientOperationId)
            )
          })
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
