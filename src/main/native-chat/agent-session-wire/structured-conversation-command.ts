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
      journal: context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
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
          let effectiveOptions = record.options
          if (command === 'clear' && !prior) {
            try {
              const options = await ctx.adapter.readOptions?.({ sessionId, fence: ctx.fence })
              effectiveOptions = {
                ...record.options,
                ...(options
                  ? {
                      model: options.current.model,
                      ...(options.current.effort ? { effort: options.current.effort } : {})
                    }
                  : {})
              }
            } catch {
              return {
                ok: false,
                refusal: {
                  code: 'agent_session_operation_invalid',
                  message:
                    'Could not read the current session configuration. Try again when the provider is connected.'
                }
              }
            }
          }
          if (effectiveOptions && command === 'clear') {
            await ctx.persistOptions(effectiveOptions)
          }
          await store.setConversationCommand(sessionId, ctx.fence, prepared)
          let error: string | undefined
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
              options: effectiveOptions
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
            ctx.publish()
            try {
              error = (
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
                      await ctx.journal.appendItem(
                        identity,
                        { kind: 'status', text: result.error ?? 'Conversation compacted.' },
                        { fence: ctx.fence }
                      )
                      await store.setConversationCommand(sessionId, ctx.fence, {
                        ...prepared,
                        phase: 'committed',
                        state: 'completed',
                        ...(result.error ? { error: result.error.slice(0, 4096) } : {})
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
                      ctx.publish()
                    })
                })
              ).error
              await host.flushStreamedEvents(sessionId)
            } catch (cause) {
              await ctx.journal.appendItem(
                identity,
                { kind: 'status', text: 'Compaction completion is unconfirmed.' },
                { fence: ctx.fence }
              )
              ctx.publish()
              throw cause
            }
            await ctx.journal.appendItem(
              identity,
              { kind: 'status', text: error ?? 'Conversation compacted.' },
              { fence: ctx.fence }
            )
            ctx.publish()
          }
          const completed = {
            ...prepared,
            phase: 'committed' as const,
            state: 'completed' as const,
            ...(error ? { error: error.slice(0, 4096) } : {})
          }
          await store.setConversationCommand(sessionId, ctx.fence, completed)
          return { ok: true, value: completed }
        }
      }
    })
  )
}
