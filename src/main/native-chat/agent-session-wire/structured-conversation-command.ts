import { createHash } from 'node:crypto'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import {
  mutateStructuredAgentSession,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-host-mutations'
import {
  conversationCommandPlan,
  type ConversationCommandAcceptance
} from './structured-agent-session-mutation-plans'
import {
  openWithAgent,
  sendPreparation,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from './structured-agent-session-send-settlement'

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

export function runStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  host: Pick<StructuredAgentSessionHost, 'attach' | 'flushStreamedEvents'>,
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
  return context.serialize(sessionId, () =>
    admitAndRunAgentSessionMutation({
      store,
      adapter: context.deps.adapter,
      callerKey: caller.callerKey,
      envelope,
      // Only the provider can do this, so an agent at rest is started first.
      prepareSession: openWithAgent(context, params.envelope),
      journal: () => context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
      flushStreamedEvents: context.flushStreamedEvents,
      now: context.now,
      plan: {
        method: 'agentSession.conversationCommand',
        fields: { command },
        recoverUnknownFromDurableState: true,
        settledOutcome: (value) => ({ status: 'succeeded', sessionId, conversationCommand: value }),
        replay: (_ctx, outcome) => {
          if (outcome.status === 'succeeded' && outcome.conversationCommand) {
            return outcome.conversationCommand
          }
          const prior = matching()
          return prior?.phase === 'committed' ? prior : null
        },
        rerunWhenReplayMissing: () => command === 'clear' && matching()?.phase === 'prepared',
        run: async (ctx) => {
          await host.flushStreamedEvents(sessionId)
          const record = store.getRecord(sessionId)!
          const prior = matching()
          const blocked =
            prior?.phase === 'prepared' && command === 'clear'
              ? null
              : conversationCommandBlocked(ctx, record)
          if (blocked) {
            return {
              ok: false,
              refusal: { code: 'agent_session_operation_invalid', message: blocked }
            }
          }
          const replacementSessionId =
            command === 'clear'
              ? (prior?.replacementSessionId ??
                `clear-${createHash('sha256')
                  .update(JSON.stringify([sessionId, caller.callerKey, clientOperationId]))
                  .digest('hex')
                  .slice(0, 40)}`)
              : undefined
          const prepared = {
            command,
            runtimeFence: ctx.fence,
            operationId: clientOperationId,
            callerKey: caller.callerKey,
            phase: 'prepared' as const,
            state: 'unknown' as const,
            ...(replacementSessionId ? { replacementSessionId } : {})
          }
          await store.setConversationCommand(sessionId, ctx.fence, prepared)
          if (command === 'clear' && replacementSessionId) {
            const attach: AgentSessionAttachParams = {
              envelope: {
                sessionId: replacementSessionId,
                clientOperationId: `${parseAgentSessionOperationTimestamp(clientOperationId)}-${createHash(
                  'sha256'
                )
                  .update(JSON.stringify([sessionId, caller.callerKey, clientOperationId]))
                  .digest('hex')
                  .slice(0, 32)}`,
                expectedRuntimeFence: null,
                payloadFingerprint: ''
              },
              location: record.location,
              accountHome: record.accountHome,
              provider: record.provider,
              agent: record.provider,
              runtimeKind: 'native',
              launchArgs: record.launchArgs,
              // The options the user chose, which any restart of this chat would replay too.
              options: record.options
            }
            attach.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
              method: 'agentSession.attach',
              sessionId: replacementSessionId,
              fields: attachFingerprintFields(attach)
            })
            const acquired = await host.attach(caller, attach)
            if (!acquired.ok) {
              if (
                !isDefinitiveAgentSessionCreateRefusal(acquired.refusal.code) &&
                store.getRecord(replacementSessionId)?.lease.claimStatus !== 'released'
              ) {
                throw new Error(acquired.refusal.message)
              }
              const failed = {
                ...prepared,
                replacementSessionId: undefined,
                phase: 'committed' as const,
                state: 'completed' as const,
                error: acquired.refusal.message.slice(0, 4096)
              }
              await store.setConversationCommand(sessionId, ctx.fence, failed)
              return { ok: true, value: failed }
            }
          }
          const completed = {
            ...prepared,
            phase: 'committed' as const,
            state: 'completed' as const
          }
          await store.setConversationCommand(sessionId, ctx.fence, completed)
          return { ok: true, value: completed }
        }
      }
    })
  )
}

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
          error: 'Compaction completion is unconfirmed; it was not run again.'
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
    value: compactionReply(settled?.value.submission)
  }
}

/** The reply shape clients already read: `completed` is now "started". */
function compactionReply(
  submission: AgentJournalSubmission | undefined
): AgentSessionConversationCommandResult {
  const error = (reason: string | null, fallback: string) => (reason ?? fallback).slice(0, 4096)
  if (!submission || isQueuedAgentJournalSubmission(submission)) {
    return { command: 'compact', state: 'unknown', error: 'The command has not started yet.' }
  }
  if (submission.dispatchState === 'rejected') {
    return {
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
        const blocked =
          structuredAgentSessionSendBlock(record) ??
          commandRefusal(
            record &&
              conversationCommandBlocked(
                ctx,
                record,
                context.sessions.get(ctx.sessionId)?.child ? undefined : 'at-rest'
              )
          )
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

function commandRefusal(message: string | null | undefined) {
  return message
    ? { ok: false as const, refusal: { code: 'agent_session_operation_invalid' as const, message } }
    : null
}
