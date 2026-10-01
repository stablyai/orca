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
import {
  agentSessionLeaseAdmitsWriter,
  agentSessionLeaseIsReleased
} from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  openWithAgent,
  structuredAgentSessionFailureWordsContext
} from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  conversationCommandInFlight,
  conversationCommandBlocked
} from './structured-conversation-command-admission'
import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailureFact } from './structured-agent-session-failure-text'
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

/** The replacement a /clear try names, and the operation id of its start. */
function clearReplacementIds(sessionId: string, callerKey: string, operationId: string) {
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, callerKey, operationId]))
    .digest('hex')
  return {
    sessionId: `clear-${digest.slice(0, 40)}`,
    attachOperationId: `${parseAgentSessionOperationTimestamp(operationId)}-${digest.slice(0, 32)}`
  }
}

/**
 * The try this caller's /clear finishes: the oldest since its last commit whose replacement start
 * reached the ledger, else this one. Read from the ledger in admission order, so a retry under a
 * fresh operation id finds the replacement an earlier try started.
 */
function clearTryToFinish(
  store: AgentSessionRecordStore,
  sessionId: string,
  callerKey: string,
  clearFingerprint: string,
  operationId: string
): string {
  const committed = store.getRecord(sessionId)?.conversationCommand
  let earliest: string | null = null
  for (const row of store.listOperationRows()) {
    if (row.callerKey !== callerKey || row.fingerprint !== clearFingerprint) {
      continue
    }
    // The record also names a commit whose ledger settlement a crash lost.
    if (
      row.outcome.status === 'succeeded' ||
      (committed?.phase === 'committed' &&
        committed.callerKey === callerKey &&
        committed.operationId === row.operationId)
    ) {
      earliest = null
    } else if (earliest === null) {
      const start = store.getOperationRow(
        callerKey,
        clearReplacementIds(sessionId, callerKey, row.operationId).attachOperationId
      )
      // Only a start that succeeded left a conversation to finish; replaying any other repeats it.
      if (start?.outcome.status === 'succeeded') {
        earliest = row.operationId
      }
    }
  }
  return earliest ?? operationId
}

/** Another caller's uncommitted /clear holds a replacement whose agent is running. One whose stop
 *  is merely unproven gates nothing: only that caller's own start would ever settle it. */
function otherCallersClearIsLive(
  store: AgentSessionRecordStore,
  sessionId: string,
  callerKey: string,
  clearFingerprint: string
): boolean {
  return store.listOperationRows().some((row) => {
    if (row.callerKey === callerKey || row.fingerprint !== clearFingerprint) {
      return false
    }
    const replacement = store.getRecord(
      clearReplacementIds(sessionId, row.callerKey, row.operationId).sessionId
    )
    return replacement !== null && agentSessionLeaseAdmitsWriter(replacement.lease)
  })
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
        // Nothing the chat reads is written before the commit, so a clear with no committed answer
        // changed nothing and runs again, finishing the replacement its earliest try started.
        rerunWhenReplayMissing: () => command === 'clear',
        run: async (ctx) => {
          await host.flushStreamedEvents(sessionId)
          const record = store.getRecord(sessionId)!
          const blocked = conversationCommandBlocked(ctx, record, context.readChildWork(sessionId))
          if (blocked) {
            return { ok: false, refusal: blocked }
          }
          let ids: ReturnType<typeof clearReplacementIds> | undefined
          if (command === 'clear') {
            const clearFingerprint = computeAgentSessionPayloadFingerprint({
              method: 'agentSession.conversationCommand',
              sessionId,
              fields: { command }
            })
            if (otherCallersClearIsLive(store, sessionId, caller.callerKey, clearFingerprint)) {
              return { ok: false, refusal: conversationCommandInFlight() }
            }
            ids = clearReplacementIds(
              sessionId,
              caller.callerKey,
              clearTryToFinish(
                store,
                sessionId,
                caller.callerKey,
                clearFingerprint,
                clientOperationId
              )
            )
          }
          const replacementSessionId = ids?.sessionId
          const base = {
            command,
            runtimeFence: ctx.fence,
            operationId: clientOperationId,
            callerKey: caller.callerKey,
            ...(replacementSessionId ? { replacementSessionId } : {})
          }
          if (ids) {
            const attach: AgentSessionAttachParams = {
              envelope: {
                sessionId: ids.sessionId,
                clientOperationId: ids.attachOperationId,
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
              sessionId: ids.sessionId,
              fields: attachFingerprintFields(attach)
            })
            const acquired = await host.attach(caller, attach)
            const replacement = store.getRecord(ids.sessionId)
            // An earlier try started this replacement and a restart or the idle sweep has since
            // stopped it: attach can't replay a settled start, but the new conversation is at rest.
            const startedAndAtRest =
              replacement !== null &&
              agentSessionLeaseIsReleased(replacement.lease) &&
              store.getOperationRow(caller.callerKey, attach.envelope.clientOperationId)?.outcome
                .status === 'succeeded'
            if (!acquired.ok && !startedAndAtRest) {
              if (
                !isDefinitiveAgentSessionCreateRefusal(acquired.refusal.code) &&
                replacement?.lease.claimStatus !== 'released'
              ) {
                throw new Error(acquired.refusal.message)
              }
              // The refusal's message is Orca's log text; the result keeps its situation instead.
              const failed = {
                ...base,
                replacementSessionId: undefined,
                phase: 'committed' as const,
                state: 'completed' as const,
                ...conversationCommandFailure(
                  structuredAgentSessionStartFailureFact({
                    refusal: acquired.refusal,
                    newSession: true
                  }),
                  { ...structuredAgentSessionFailureWordsContext(record), command: 'clear' }
                )
              }
              await store.setConversationCommand(sessionId, ctx.fence, failed)
              return { ok: true, value: failed }
            }
            // Carry the source's drafts to the replacement, the same for every client version:
            // the cards stay visible where the user now is, and no text rides the wire.
            // Bookkeeping — a failure is reported and never fails the clear.
            await carryQueuedMessagesToClearReplacement(ctx, {
              replacementSessionId: ids.sessionId,
              replacementJournal: context.sessions.get(ids.sessionId)?.journal,
              callerKey: caller.callerKey,
              operationId: clientOperationId
            })
          }
          const completed = {
            ...base,
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
