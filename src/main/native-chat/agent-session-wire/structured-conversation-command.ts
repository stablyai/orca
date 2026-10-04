import { randomBytes } from 'node:crypto'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { sendPreparation } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  committedClearOfCaller,
  conversationCommandBlocked
} from './structured-conversation-command-admission'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { carryQueuedMessagesToClearReplacement } from './structured-agent-session-queued-mutations'

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
}
export type ConversationReplacement = {
  sourceSessionId: string
  sessionId: string
  workspaceId: string
  agent: 'claude' | 'codex'
}

const clearFingerprintOf = (sessionId: string) =>
  computeAgentSessionPayloadFingerprint({
    method: 'agentSession.conversationCommand',
    sessionId,
    fields: { command: 'clear' }
  })

/** This caller's committed /clear, for a /clear it presses again on the conversation that one
 *  cleared. Answered before admission, which would refuse it as cleared. */
async function answerFromCommittedClear(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  { envelope, command }: ConversationCommandParams
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult> | null> {
  const { store } = context.deps
  const record = store.getRecord(envelope.sessionId)
  const committed =
    command === 'clear' && envelope.payloadFingerprint === clearFingerprintOf(envelope.sessionId)
      ? committedClearOfCaller(record, caller.callerKey, store.getSessionTabId(envelope.sessionId))
      : null
  const session =
    committed && (await context.openConversation(envelope.sessionId).catch(() => null))
  return record && committed && session
    ? {
        ok: true,
        replayed: true,
        fence: record.lease.runtimeFence,
        cursor: session.journal.cursor(),
        value: committed
      }
    : null
}

/**
 * `/clear`: one write that points this conversation at a new, at-rest one and moves its tab there.
 * The new conversation's first send starts its agent.
 */
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
    const committed = await answerFromCommittedClear(context, caller, params)
    if (committed) {
      return committed
    }
    return admitAndRunAgentSessionMutation({
      store,
      adapter: context.deps.adapter,
      logger: context.deps.logger,
      callerKey: caller.callerKey,
      envelope,
      // Starts the agent only to settle a rewind in doubt, as a send does; a /clear itself starts nothing.
      prepareSession: sendPreparation(context, envelope),
      journal: () => context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
      now: context.now,
      plan: {
        method: 'agentSession.conversationCommand',
        fields: { command },
        // Written to the conversation, not the agent, so whoever owns the agent does not matter.
        conversationWrite: true,
        recoverUnknownFromDurableState: true,
        settledOutcome: (value) => ({ status: 'succeeded', sessionId, conversationCommand: value }),
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
          // Stopped before the marker, so nothing the old agent does can land after the clear. The
          // stop releases the lease, which moves its fence: the marker is written at the new one.
          // A /clear replaces this chat: the user closing it.
          await context.stopAgent(sessionId, { cause: 'user-close' })
          const fence = store.getRecord(sessionId)!.lease.runtimeFence
          const completed = {
            command,
            runtimeFence: fence,
            operationId: clientOperationId,
            callerKey: caller.callerKey,
            // Only has to be new: the marker is what points at it, and a same-id resend replays it.
            replacementSessionId: `clear-${randomBytes(20).toString('hex')}`,
            phase: 'committed' as const,
            state: 'completed' as const
          }
          await store.commitConversationClear({
            sessionId,
            fence,
            command: completed,
            claimKeyId: context.deps.claimKeyId,
            now: context.now()
          })
          // Carry the source's drafts to the replacement, the same for every client version:
          // the cards stay visible where the user now is, and no text rides the wire.
          // Bookkeeping — a failure is reported and never fails the clear.
          await carryQueuedMessagesToClearReplacement(ctx, {
            replacementSessionId: completed.replacementSessionId,
            // Opened under its own lock, as every open is.
            openReplacementJournal: async () =>
              (await context.conversation(completed.replacementSessionId)).journal,
            callerKey: caller.callerKey,
            operationId: clientOperationId
          })
          return { ok: true, value: completed }
        }
      }
    })
  })
}
