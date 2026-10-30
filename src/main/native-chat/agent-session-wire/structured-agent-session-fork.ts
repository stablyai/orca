import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
import { agentSessionFingerprintConflict } from '../../../shared/agent-session-mutation-envelope'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError,
  refuse,
  type AgentSessionAttachResult,
  type AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  foundConversation,
  type StructuredAgentSessionCreateOptions
} from './structured-agent-session-create'
import { reserveRequestFor, type AgentSessionAttachParams } from './structured-agent-session-attach'
import { providerItemIdOf } from './structured-rewind-cut'
import { rewindInDoubt } from './structured-agent-session-send-preparation'
import { hostCanStartRecord } from './structured-agent-session-provider-support'
import {
  agentSessionOperationOutcomeUnknown,
  resolveAgentSessionReplayOutcome
} from './structured-agent-session-replay-outcome'

/** Serialize the child operation, then hold the parent's mutation lane through native materialization. */
export function forkStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: StructuredAgentSessionCreateParams,
  options: Pick<StructuredAgentSessionCreateOptions, 'publishTab'> = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const store = context.deps.store
  const replay = store.getOperationRow(caller.callerKey, params.envelope.clientOperationId)
  const sourceId = replay
    ? replay.outcome.status === 'succeeded'
      ? replay.outcome.sessionId
      : undefined
    : params.forkFrom?.sessionId
  const location = sourceId ? store.getConversation(sourceId)?.location : undefined
  return context.tasks.trackAttach(
    context.serialize(params.envelope.sessionId, async () => {
      let claimed = false
      try {
        const { forkFrom, envelope } = params
        if (
          !forkFrom ||
          params.agent !== 'codex' ||
          envelope.expectedRuntimeFence !== null ||
          forkFrom.sessionId === envelope.sessionId ||
          params.resumeFrom ||
          params.firstMessage ||
          params.options ||
          params.optionsMode
        ) {
          throw agentSessionRefusalError('agent_session_operation_invalid', {
            reason: 'requestMalformed'
          })
        }
        const fingerprint = structuredAgentSessionCreateFingerprint({
          sessionId: envelope.sessionId,
          ...params
        })
        const conflict = agentSessionFingerprintConflict(envelope, fingerprint)
        if (conflict) {
          return { ok: false, refusal: conflict }
        }
        // Replay precedes parent lookup: closing or clearing the parent cannot change the child.
        const prior = store.getOperationRow(caller.callerKey, envelope.clientOperationId)
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            throw agentSessionRefusalError('agent_session_operation_conflict', {
              reason: 'operationIdReused'
            })
          }
          if (prior.outcome.status !== 'succeeded') {
            const replay = resolveAgentSessionReplayOutcome({
              operationId: envelope.clientOperationId,
              outcome: prior.outcome,
              reconstruct: () => null
            })
            return {
              ok: false,
              refusal:
                replay.decision === 'refuse'
                  ? replay.refusal
                  : agentSessionOperationOutcomeUnknown(envelope.clientOperationId)
            }
          }
          const child = store.getRecord(prior.outcome.sessionId)
          if (!child || child.sessionId !== envelope.sessionId) {
            return {
              ok: false,
              refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId)
            }
          }
          return foundConversation(
            context,
            caller.callerKey,
            inheritedParams(child, params),
            options
          )
        }
        if (store.getRecord(envelope.sessionId)) {
          throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
        }
        // Missing parents cannot hold another pending create's lane in a reverse lock cycle.
        store.requireWritableRecord(forkFrom.sessionId)
        const acquisition = context.runtimeState.acquireAborts.begin(envelope.sessionId)
        try {
          return await context.serialize(forkFrom.sessionId, async () => {
            throwIfSignalAborted(acquisition.signal)
            const record = store.requireWritableRecord(forkFrom.sessionId)
            if (
              record.provider !== 'codex' ||
              !hostCanStartRecord(context.deps, record) ||
              params.worktree !== `id:${record.location.workspaceId}` ||
              !context.deps.adapter.forkConversation
            ) {
              throw agentSessionRefusalError('structured_agent_session_unsupported', {
                reason: 'hostUnsupported'
              })
            }
            if (
              rewindInDoubt(record) ||
              record.conversationCommand?.phase === 'prepared' ||
              record.lease.handoffStage ||
              record.lease.handoffOperationId
            ) {
              throw agentSessionRefusalError('agent_session_operation_unknown', {
                reason: 'outcomeUnknown'
              })
            }
            await context.deps.assertNoTerminalWriter?.(record)
            const parent = await context.openConversation(record.sessionId)
            if (!parent) {
              throw new Error('The source chat is unavailable.')
            }
            await context.runtimeState.flushEventSink(record.sessionId)
            const journal = parent.journal
            if (journal.cursor().epoch !== forkFrom.expectedEpoch) {
              throw new Error('The source chat changed. Select the completed response again.')
            }
            const snapshot = journal.snapshot()
            const selected = snapshot.items.find((item) => item.itemId === forkFrom.itemId)
            const floor = journal.context.floor()
            const identity = selected
              ? parseAgentJournalItemKey(providerItemIdOf(journal, selected.itemId))
              : null
            const head = record.providerHandleChain.at(-1)?.handle
            const turn =
              selected?.turnScope?.kind === 'turn'
                ? readAgentJournalTurn(journal.itemBody(selected.turnScope.turnItemId) ?? undefined)
                : null
            if (
              !selected ||
              selected.body.kind !== 'message' ||
              selected.body.role !== 'assistant' ||
              !isRootAgentJournalItem(selected) ||
              (floor && selected.sequence <= floor.sequence) ||
              identity?.provider !== 'codex' ||
              head?.nativeId !== identity.threadId ||
              turn?.state !== 'completed' ||
              readAgentJournalTurnOutcome(turn) !== 'success'
            ) {
              throw new Error('Choose a successfully completed Codex response to branch from.')
            }
            const attach = inheritedParams(record, params)
            // Validate ordinary founding before any native effect, including tab and model admission.
            store.founding.prepare(
              reserveRequestFor({
                sessionId: envelope.sessionId,
                params: attach,
                callerKey: caller.callerKey,
                fingerprint,
                now: context.now(),
                authority: {
                  claimKeyId: context.deps.claimKeyId,
                  handoffOperationId: null,
                  probe: { outcome: 'pid-absent' },
                  spawnToken: () => {
                    throw new Error('fork_must_not_reserve_a_spawn')
                  },
                  ...(record.launchDirectory ? { launchDirectory: record.launchDirectory } : {})
                }
              })
            )
            const forked = await context.deps.adapter.forkConversation({
              record,
              sessionId: envelope.sessionId,
              lastTurnId: identity.turnId,
              signal: acquisition.signal,
              beforeFork: async () => {
                throwIfSignalAborted(acquisition.signal)
                const admitted = await store.admitAndClaimOperation(
                  {
                    callerKey: caller.callerKey,
                    operationId: envelope.clientOperationId,
                    fingerprint,
                    now: context.now()
                  },
                  (decision) => decision.decision === 'admit'
                )
                if (admitted.claim?.claim !== 'won') {
                  if (admitted.decision.decision === 'refused') {
                    throw agentSessionRefusalError(
                      admitted.decision.code,
                      admitted.decision.details
                    )
                  }
                  throw agentSessionRefusalError('agent_session_operation_unknown', {
                    reason: 'outcomeUnknown'
                  })
                }
                claimed = true
              }
            })
            throwIfSignalAborted(acquisition.signal)
            if (
              !claimed ||
              forked.items.length === 0 ||
              forked.providerHandle.nativeId === head.nativeId
            ) {
              throw new Error('Codex did not return an independent branch with complete history.')
            }
            const result = await foundConversation(
              context,
              caller.callerKey,
              {
                ...attach,
                options: { ...attach.options, ...forked.options },
                adopt: { providerHandle: forked.providerHandle }
              },
              {
                ...options,
                materialized: { items: forked.items },
                hostLaunchDirectory: record.launchDirectory
              }
            )
            if (!result.ok) {
              throw new Error(result.refusal.message)
            }
            return result
          })
        } finally {
          acquisition.end()
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (claimed) {
          return {
            ok: false,
            refusal: refuse(
              'agent_session_operation_unknown',
              { reason: 'outcomeUnknown' },
              `Codex may have created the branch. It was not retried: ${message}`
            )
          }
        }
        const refusal = isAgentSessionRefusalError(error)
          ? error.refusal
          : refuse('agent_session_operation_invalid', { reason: 'requestMalformed' }, message)
        return { ok: false, refusal: { ...refusal, createAttemptRefusedBeforeCommit: true } }
      }
    }),
    location ? { sessionId: params.envelope.sessionId, location } : undefined
  )
}

function inheritedParams(
  record: AgentSessionRecord,
  params: StructuredAgentSessionCreateParams
): AgentSessionAttachParams {
  return {
    envelope: params.envelope,
    location: record.location,
    provider: 'codex',
    agent: 'codex',
    runtimeKind: 'native',
    accountHome: record.accountHome,
    options: {
      ...record.options,
      ...(record.permissionMode
        ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: record.permissionMode }
        : {})
    },
    ...(record.launchArgs ? { launchArgs: [...record.launchArgs] } : {}),
    ...(params.tabId ? { surfaceTabId: params.tabId } : {}),
    forkedFrom:
      record.sessionId === params.envelope.sessionId
        ? record.forkedFrom
        : params.forkFrom && {
            sessionId: params.forkFrom.sessionId,
            itemId: params.forkFrom.itemId
          }
  }
}
