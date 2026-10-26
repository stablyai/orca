import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type {
  AgentSessionRewindParams,
  AgentSessionRewindRecord,
  AgentSessionRewindResult
} from '../../../shared/agent-session-rewind'
import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  runWithReadyStructuredAgentSessionOperation,
  openWithReadyStructuredAgentSessionChild,
  type ReadyOperationSelection
} from './structured-agent-session-ready-operation'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import { completedStructuredRewind } from './structured-rewind-replay'
import { rewindRefusal, rewindRefusalBehindClear } from './structured-rewind-refusal'
import {
  isStructuredRewindTarget,
  providerItemIdOf,
  structuredRewindCut
} from './structured-rewind-cut'
import { persistRewindRecord, recoverStructuredRewind } from './structured-rewind-recovery'
import { rewindInDoubt, sendPreparation } from './structured-agent-session-send-preparation'

export async function rewindStructuredAgentSession(
  context: StructuredAgentSessionMutationContext,
  attachContext: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionRewindParams
): Promise<AgentSessionMutationResult<AgentSessionRewindResult>> {
  const { sessionId, clientOperationId } = params.envelope
  const {
    readChildWork,
    childWorkOpen,
    deps: { store }
  } = context
  const fields = { itemId: params.itemId, expectedEpoch: params.expectedEpoch }
  const operation = { method: 'agentSession.rewind', fields }
  // Forks need only conversation access; native rewinds require the provider.
  const agent = store.getRecord(sessionId)?.provider
  const rewindsByFork =
    agent !== undefined &&
    context.deps.agents.registration(agent)?.adapter.forkForRewind !== undefined
  const run = async (selection: ReadyOperationSelection) => {
    let completionReceipt: JournalOperationReceipt | undefined
    const result = await admitAndRunAgentSessionMutation<AgentSessionRewindResult>({
      store,
      adapter: context.deps.adapter,
      agents: context.deps.agents,
      logger: context.deps.logger,
      callerKey: caller.callerKey,
      envelope: params.envelope,
      prepareSession: rewindsByFork
        ? sendPreparation(context, params.envelope, { refusesInRun: true }, selection)
        : openWithReadyStructuredAgentSessionChild(context, params.envelope, selection),
      journal: () => context.sessions.get(sessionId)?.journal,
      currentWork: () =>
        hostStructuredAgentSessionCurrentWork({ store, sessions: context.sessions }, sessionId),
      publish: (journal) => context.publish(sessionId, journal),
      now: context.now,
      plan: {
        ...operation,
        ...(rewindsByFork ? { conversationWrite: true } : {}),
        recoverUnknownFromDurableState: true,
        settledOutcome: (rewind: AgentSessionRewindResult) => ({
          status: 'succeeded' as const,
          sessionId,
          rewind
        }),
        settlesWithWrite: true,
        successReceipt: () => ({
          write: (db) => completionReceipt!.write(db),
          committed: () => completionReceipt!.committed()
        }),
        replay: (_ctx, outcome) => {
          if (outcome.status === 'succeeded' && outcome.rewind) {
            return outcome.rewind
          }
          return completedStructuredRewind(
            store.getRecord(sessionId)?.rewind,
            caller.callerKey,
            clientOperationId
          )
        },
        run: async (ctx) => {
          await attachContext.runtimeState.flushEventSink(sessionId)
          const record = store.getRecord(sessionId)!
          const support = ctx.adapter.rewindSupport?.(sessionId, ctx.agent)
          if (!support?.supported) {
            return rewindRefusal(support?.reason ?? 'unsupported')
          }
          if (rewindInDoubt(record)) {
            return rewindRefusal('outcome-unknown')
          }
          const childWork = { views: readChildWork(sessionId), open: childWorkOpen(sessionId) }
          if (conversationCommandBlocked(ctx, record, childWork, 'handover')) {
            return rewindRefusal('busy')
          }
          if (ctx.journal.cursor().epoch !== params.expectedEpoch) {
            return rewindRefusal('stale-epoch')
          }
          if (!isStructuredRewindTarget(ctx.journal, params.itemId)) {
            return rewindRefusal('invalid-target')
          }
          const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
          const cut = head
            ? structuredRewindCut(ctx.journal, {
                itemId: params.itemId,
                provider: record.provider,
                nativeId: head.nativeId
              })
            : null
          if (!cut) {
            return rewindRefusal('invalid-target')
          }
          const fork =
            'beforeMessage' in cut
              ? await ctx.adapter.forkForRewind?.({
                  record,
                  beforeMessage: cut.beforeMessage,
                  rewindOperationId: clientOperationId
                })
              : undefined
          if (fork && !fork.ok) {
            return rewindRefusal(fork.reason)
          }
          const contextFloor = ctx.journal.context.floor()
          const prepared: AgentSessionRewindRecord = {
            operationId: clientOperationId,
            callerKey: caller.callerKey,
            itemId: params.itemId,
            providerItemId: providerItemIdOf(ctx.journal, params.itemId),
            expectedEpoch: params.expectedEpoch,
            phase: 'prepared',
            ...(fork?.ok ? { providerFork: fork.fork } : {}),
            ...(contextFloor && record.providerContextBoundary
              ? {
                  contextClearOperationId: record.providerContextBoundary.operationId,
                  contextClearSequence: contextFloor.sequence
                }
              : {})
          }
          await persistRewindRecord(store, sessionId, ctx.fence, prepared)
          ctx.publish()
          const provider =
            'beforeTurnId' in cut
              ? await ctx.adapter.rewind!({
                  sessionId,
                  fence: ctx.fence,
                  beforeTurnId: cut.beforeTurnId
                })
              : await stopForFork(context, sessionId)
          const fence = store.getRecord(sessionId)!.lease.runtimeFence
          if (!provider.ok) {
            const reason = provider.reason
            if (reason !== 'outcome-unknown') {
              await persistRewindRecord(store, sessionId, fence, {
                ...prepared,
                phase: 'refused',
                reason
              })
              const currentJournal = context.sessions.get(sessionId)?.journal
              if (currentJournal) {
                context.publish(sessionId, currentJournal)
              }
            }
            return rewindRefusal(reason)
          }
          await persistRewindRecord(store, sessionId, fence, {
            ...prepared,
            phase: 'provider-succeeded'
          })
          const journal = context.sessions.get(sessionId)!.journal
          await attachContext.runtimeState.flushEventSink(sessionId)
          await recoverStructuredRewind(
            context.deps,
            sessionId,
            journal,
            fence,
            undefined,
            (rewind, currentFence, cursor) => {
              completionReceipt = store.conversationReceipts.rewind(
                sessionId,
                currentFence,
                rewind,
                cursor
              )
              return ctx.operationReceipt!
            }
          )
          context.publish(sessionId, journal)
          return {
            ok: true,
            value: {
              itemId: params.itemId,
              epoch: journal.cursor().epoch,
              ...(contextFloor ? { sequence: journal.cursor().sequence } : {})
            }
          }
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
  }
  return runWithReadyStructuredAgentSessionOperation(
    context,
    caller.callerKey,
    params.envelope,
    operation,
    run,
    {
      needsAgent: () => !rewindsByFork,
      beforeAgent: () => rewindRefusalBehindClear(context.sessions.get(sessionId)?.journal, params)
    }
  )
}

/** Stop the old child so the next start resumes the fork. */
async function stopForFork(
  context: StructuredAgentSessionMutationContext,
  sessionId: string
): Promise<{ ok: true }> {
  await context.stopAgent(sessionId, { cause: 'evict', resting: true })
  return { ok: true }
}
