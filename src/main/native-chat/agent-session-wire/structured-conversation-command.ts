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
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import {
  agentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { agentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import { agentSessionFailureText } from './structured-agent-session-failure-text'
import type { StructuredSessionCompactionResult } from './structured-session-compaction'

/** A failed compaction, keeping only what the provider wrote for a person. */
function compactionFailure(
  result: StructuredSessionCompactionResult
): AgentSessionFailureFact | undefined {
  return result.error === undefined
    ? undefined
    : agentSessionFailureFact('compactionFailed', { detail: result.detail })
}

function compactionStatusBody(failure: AgentSessionFailureFact | undefined) {
  return failure
    ? { kind: 'status' as const, text: agentSessionFailureText(failure), failure }
    : { kind: 'status' as const, text: 'Conversation compacted.' }
}

function compactionCommandFailure(failure: AgentSessionFailureFact | undefined): {
  error?: string
  failure?: AgentSessionFailureFact
} {
  return failure ? { error: agentSessionFailureText(failure).slice(0, 4096), failure } : {}
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
          if (prior?.phase === 'committed') {
            return prior
          }
          if (command === 'compact' && prior && outcome.status !== 'unknown') {
            return {
              command,
              state: 'unknown',
              error: 'Compaction completion is unconfirmed; it was not run again.'
            }
          }
          return outcome.status === 'succeeded' && command === 'compact'
            ? { command, state: 'completed' }
            : null
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
            return { ok: false, refusal: blocked }
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
          let failure: AgentSessionFailureFact | undefined
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
              // The refusal's message is Orca's log text; the result keeps its situation instead.
              const failed = {
                ...prepared,
                replacementSessionId: undefined,
                phase: 'committed' as const,
                state: 'completed' as const,
                error: "The new conversation couldn't start.",
                failure: agentSessionFailureFact('restartFailed', {
                  refusal: agentSessionRefusalReference(acquired.refusal)
                })
              }
              await store.setConversationCommand(sessionId, ctx.fence, failed)
              return { ok: true, value: failed }
            }
          } else {
            if (!ctx.adapter.compact) {
              throw new Error('Compaction is unavailable for this provider.')
            }
            const identity = {
              provider: 'orca' as const,
              clientMessageId: `compact:${clientOperationId}`
            }
            await ctx.journal.appendItem(
              identity,
              {
                kind: 'status',
                text: 'Compacting conversation…',
                turnLifecycle: { turnId: `compact:${clientOperationId}`, state: 'running' }
              },
              { fence: ctx.fence }
            )
            try {
              failure = compactionFailure(
                await ctx.adapter.compact({
                  turnId: `compact:${clientOperationId}`,
                  sessionId,
                  fence: ctx.fence,
                  onLateResult: (result) =>
                    context.serialize(sessionId, async () => {
                      if (
                        matching()?.phase !== 'prepared' ||
                        context.sessions.get(sessionId)?.journal !== ctx.journal
                      ) {
                        return
                      }
                      await host.flushStreamedEvents(sessionId)
                      const late = compactionFailure(result)
                      await ctx.journal.appendItem(identity, compactionStatusBody(late), {
                        fence: ctx.fence
                      })
                      await store.setConversationCommand(sessionId, ctx.fence, {
                        ...prepared,
                        phase: 'committed',
                        state: 'completed',
                        ...compactionCommandFailure(late)
                      })
                      await store.recordOperationOutcome({
                        callerKey: caller.callerKey,
                        operationId: clientOperationId,
                        outcome: {
                          status: 'succeeded',
                          sessionId,
                          conversationCommand: matching()!
                        }
                      })
                    })
                })
              )
              await host.flushStreamedEvents(sessionId)
            } catch (cause) {
              await ctx.journal.appendItem(
                identity,
                compactionStatusBody(agentSessionFailureFact('compactionUnconfirmed')),
                { fence: ctx.fence }
              )
              throw cause
            }
            await ctx.journal.appendItem(identity, compactionStatusBody(failure), {
              fence: ctx.fence
            })
          }
          const completed = {
            ...prepared,
            phase: 'committed' as const,
            state: 'completed' as const,
            ...compactionCommandFailure(failure)
          }
          await store.setConversationCommand(sessionId, ctx.fence, completed)
          return { ok: true, value: completed }
        }
      }
    })
  )
}
