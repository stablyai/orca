import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionRewindParams,
  AgentSessionRewindRecord,
  AgentSessionRewindResult
} from '../../../shared/agent-session-rewind'
import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import { rewindRefusal } from './structured-rewind-refusal'
import { persistRewindRecord, recoverStructuredRewind } from './structured-rewind-recovery'
import { replaceClaudeRewindOwner } from './structured-rewind-claude-owner'

export async function rewindStructuredAgentSession(
  context: StructuredAgentSessionMutationContext,
  attachContext: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionRewindParams
): Promise<AgentSessionMutationResult<AgentSessionRewindResult>> {
  const { sessionId, clientOperationId } = params.envelope
  const store = context.deps.store
  return context.serialize(sessionId, async () => {
    const result = await admitAndRunAgentSessionMutation<AgentSessionRewindResult>({
      store,
      adapter: context.deps.adapter,
      callerKey: caller.callerKey,
      envelope: params.envelope,
      journal: context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
      now: context.now,
      plan: {
        method: 'agentSession.rewind',
        fields: { itemId: params.itemId, expectedEpoch: params.expectedEpoch },
        recoverUnknownFromDurableState: true,
        settledOutcome: (rewind) => ({ status: 'succeeded', sessionId, rewind }),
        replay: (_ctx, outcome) => {
          if (outcome.status === 'succeeded' && outcome.rewind) {
            return outcome.rewind
          }
          const prior = store.getRecord(sessionId)?.rewind
          return prior?.operationId === clientOperationId &&
            prior.callerKey === caller.callerKey &&
            prior.phase === 'completed' &&
            prior.epoch
            ? { itemId: prior.itemId, epoch: prior.epoch }
            : null
        },
        run: async (ctx) => {
          await attachContext.runtimeState.flushEventSink(sessionId)
          const record = store.getRecord(sessionId)!
          const support = ctx.adapter.rewindSupport?.(sessionId)
          if (!support?.supported) {
            return rewindRefusal(support?.reason ?? 'unsupported')
          }
          if (
            record.rewind?.phase === 'prepared' ||
            record.rewind?.phase === 'provider-succeeded'
          ) {
            return rewindRefusal('outcome-unknown')
          }
          if (conversationCommandBlocked(ctx, record)) {
            return rewindRefusal('busy')
          }
          if (ctx.journal.isReadOnly) {
            return rewindRefusal('unsupported')
          }
          const snapshot = ctx.journal.snapshot()
          const providerKeys = new Map(
            snapshot.submissions.flatMap((submission) =>
              submission.dispatchState === 'accepted' && submission.providerItemId
                ? [
                    [
                      agentJournalSubmissionKey(submission.clientMessageId),
                      submission.providerItemId
                    ] as const
                  ]
                : []
            )
          )
          const providerKey = (itemId: string) => providerKeys.get(itemId) ?? itemId
          if (ctx.journal.cursor().epoch !== params.expectedEpoch) {
            return rewindRefusal('stale-epoch')
          }
          const selected = snapshot.items.findIndex((item) => item.itemId === params.itemId)
          const key = selected === -1 ? null : parseAgentJournalItemKey(providerKey(params.itemId))
          const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
          if (!key || !head || key.provider !== head.provider) {
            return rewindRefusal('invalid-target')
          }
          let boundary = selected
          let claude: Parameters<typeof replaceClaudeRewindOwner>[3] | undefined
          if (key.provider === 'codex' && head.provider === 'codex') {
            if (key.threadId !== head.threadId) {
              return rewindRefusal('invalid-target')
            }
            boundary = snapshot.items.findIndex((item) => {
              const identity = parseAgentJournalItemKey(providerKey(item.itemId))
              return (
                (identity?.provider === 'codex' &&
                  identity.threadId === key.threadId &&
                  identity.turnId === key.turnId) ||
                (item.body.kind === 'status' && item.body.turnLifecycle?.turnId === key.turnId)
              )
            })
          } else if (key.provider === 'claude' && head.provider === 'claude') {
            if (key.sessionId !== head.sessionId) {
              return rewindRefusal('invalid-target')
            }
            const previous = snapshot.items
              .slice(0, boundary)
              .map((item) => parseAgentJournalItemKey(providerKey(item.itemId)))
              .findLast(
                (identity) =>
                  identity?.provider === 'claude' && identity.sessionId === key.sessionId
              )
            if (previous?.provider !== 'claude') {
              return rewindRefusal('invalid-target')
            }
            const prompts = snapshot.items
              .slice(boundary)
              .filter((item) => item.body.kind === 'message' && item.body.role === 'user')
            const prompt =
              prompts.length === 1
                ? parseAgentJournalItemKey(providerKey(prompts[0]!.itemId))
                : null
            claude = {
              targetUuid: previous.uuid,
              previousLeafUuid: head.leafUuid ?? '',
              ...(prompt?.provider === 'claude' ? { dropsTurn: prompt.uuid } : {})
            }
          } else {
            return rewindRefusal('invalid-target')
          }
          const retained = snapshot.items
            .slice(0, boundary)
            .map(({ itemId, body, observedAt }) => ({
              itemId: providerKey(itemId),
              body,
              observedAt
            }))
          if (
            retained.length > 10_000 ||
            Buffer.byteLength(JSON.stringify(retained), 'utf8') >
              AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
          ) {
            return rewindRefusal('history-limit')
          }
          let prepared: AgentSessionRewindRecord = {
            operationId: clientOperationId,
            callerKey: caller.callerKey,
            itemId: params.itemId,
            providerItemId: providerKey(params.itemId),
            expectedEpoch: params.expectedEpoch,
            phase: 'prepared',
            retained
          }
          await persistRewindRecord(store, sessionId, ctx.fence, prepared)
          ctx.publish()
          const provider = claude
            ? await replaceClaudeRewindOwner(attachContext, caller.callerKey, params, claude)
            : await ctx.adapter.rewind!({
                sessionId,
                fence: ctx.fence,
                beforeTurnId: key.provider === 'codex' ? key.turnId : '',
                onPrepared: async (items) => {
                  const retained = items.map(({ identity, body }) => ({
                    itemId: agentJournalItemKey(identity),
                    body,
                    observedAt: ctx.now()
                  }))
                  if (
                    retained.length > 10_000 ||
                    Buffer.byteLength(JSON.stringify(retained), 'utf8') >
                      AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
                  ) {
                    throw new Error('agent_session_rewind:history-limit')
                  }
                  prepared = { ...prepared, retained }
                  await persistRewindRecord(store, sessionId, ctx.fence, prepared)
                },
                onReverted: async () => {
                  await persistRewindRecord(store, sessionId, ctx.fence, {
                    ...prepared,
                    providerApplied: true
                  })
                }
              })
          const fence = store.getRecord(sessionId)!.lease.runtimeFence
          if (!provider.ok) {
            const reason =
              'reason' in provider
                ? provider.reason
                : (provider.refusal.rewindReason ?? 'outcome-unknown')
            if (reason !== 'outcome-unknown') {
              await persistRewindRecord(store, sessionId, fence, {
                ...prepared,
                phase: 'refused',
                reason,
                retained: []
              })
              const currentJournal = context.sessions.get(sessionId)?.journal
              if (currentJournal) {
                context.publish(sessionId, currentJournal)
              }
            }
            return rewindRefusal(reason)
          }
          const confirmed = provider.items
            ? provider.items.map(({ identity, body }) => ({
                itemId: agentJournalItemKey(identity),
                body,
                observedAt: ctx.now()
              }))
            : prepared.retained
          if (
            Buffer.byteLength(JSON.stringify(confirmed), 'utf8') >
            AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
          ) {
            throw new Error('agent_session_rewind:history-limit')
          }
          await persistRewindRecord(store, sessionId, fence, {
            ...prepared,
            retained: confirmed,
            phase: 'provider-succeeded',
            hydrationVerified: true
          })
          const journal = context.sessions.get(sessionId)!.journal
          await attachContext.runtimeState.flushEventSink(sessionId)
          await recoverStructuredRewind(store, sessionId, journal, fence)
          context.publish(sessionId, journal)
          return { ok: true, value: { itemId: params.itemId, epoch: journal.cursor().epoch } }
        }
      }
    })
    return result.ok
      ? {
          ...result,
          fence: store.getRecord(sessionId)!.lease.runtimeFence,
          cursor: context.sessions.get(sessionId)!.journal.cursor()
        }
      : result
  })
}
