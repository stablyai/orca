import { forkJournalSeed } from './structured-fork-journal-seed'
import { restoreRewindJournalBody } from './structured-rewind-journal-body'
import type { AgentSessionRewindReason } from '../../../shared/agent-session-rewind'
import { prepareStructuredForkReplay } from './structured-agent-session-fork-replay'
import { restartRefusedStructuredFork } from './structured-agent-session-fork-lifecycle'
import type {
  AgentSessionForkRecord,
  AgentSessionForkSource
} from '../../../shared/agent-session-fork'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionExecutionLocationsEqual } from '../../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { selectAgentSessionPrefix } from '../../../shared/agent-session-prefix'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

type ForkContext = Pick<
  StructuredAgentSessionMutationContext,
  'deps' | 'sessions' | 'serialize' | 'now'
>

type PreparedFork =
  | { refusal: AgentSessionMutationResult<never> }
  | { attach: AgentSessionAttachParams; fork: AgentSessionForkRecord; restartRefused: boolean }

/**
 * Source serialization buys exactly one thing: a prefix selected against a runtime fence and epoch
 * proven not to have moved, from a parent whose journal is flushed and quiescent. That is a
 * snapshot, and it is complete the moment the prefix is chosen.
 *
 * It deliberately does NOT extend over the child's provider bring-up below. Every parent mutation
 * takes this same key, so holding it across a process spawn and a paginated history read froze the
 * parent conversation — the user could not even cancel a running turn there — for as long as the
 * child took to come up. Nothing after this point reads or writes the parent: replay, re-arming and
 * attach are all keyed on the CHILD session id, and the child's own idempotency is durable (the
 * operation ledger and the record CAS), not a consequence of holding the parent's key.
 */
export async function forkStructuredAgentSession(
  context: ForkContext,
  attachContext: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams,
  source: AgentSessionForkSource
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  if (
    source.sessionId === params.envelope.sessionId ||
    params.adopt ||
    params.envelope.expectedRuntimeFence !== null
  ) {
    return refuse('invalid-target')
  }
  const prepared = await context.serialize(source.sessionId, () =>
    snapshotStructuredForkSource(context, attachContext, caller, params, source)
  )
  if ('refusal' in prepared) {
    return prepared.refusal
  }
  // Ordered: replay reads the settled `refused` record to mint the recovery envelope this
  // existing child record requires, and only then is the record re-armed for a fresh attempt.
  const replay = await prepareStructuredForkReplay(context, caller, prepared.attach)
  if (replay.result) {
    return replay.result
  }
  if (prepared.restartRefused) {
    await restartRefusedStructuredFork(context.deps.store, params.envelope.sessionId, prepared.fork)
  }
  return attachStructuredAgentSession(attachContext, caller.callerKey, replay.params)
}

/** Runs under the source session's key; see `forkStructuredAgentSession`. */
async function snapshotStructuredForkSource(
  context: ForkContext,
  attachContext: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams,
  source: AgentSessionForkSource
): Promise<PreparedFork> {
  const store = context.deps.store
  const target = store.getRecord(params.envelope.sessionId)
  const parent = store.getRecord(source.sessionId)
  const prior = target?.fork
  if (
    prior &&
    (prior.operationId !== params.envelope.clientOperationId ||
      prior.callerKey !== caller.callerKey)
  ) {
    return { refusal: refuse('invalid-target') }
  }
  if (
    prior &&
    (prior.sourceSessionId !== source.sessionId ||
      prior.itemId !== source.itemId ||
      prior.expectedEpoch !== source.expectedEpoch ||
      prior.expectedRuntimeFence !== source.expectedRuntimeFence)
  ) {
    return { refusal: refuse('invalid-target') }
  }
  const pinned = prior ? target : parent
  if (
    !pinned ||
    pinned.provider !== params.provider ||
    !agentSessionExecutionLocationsEqual(pinned.location, params.location)
  ) {
    return { refusal: refuse('invalid-target') }
  }
  // A refused attempt proved no provider session exists, so the retry re-derives the prefix
  // instead of replaying a record whose retained copy was dropped when it settled.
  let fork = prior?.phase === 'refused' ? undefined : prior
  if (!fork) {
    const support = context.deps.adapter.forkSupport?.(source.sessionId)
    if (!support?.supported) {
      return {
        refusal: refuse(
          support?.reason === 'history-not-paginated' ? support.reason : 'unsupported'
        )
      }
    }
    const session = context.sessions.get(source.sessionId)
    if (!parent || !session || !agentSessionLeaseAdmitsWriter(parent.lease)) {
      return { refusal: refuse('busy') }
    }
    await attachContext.runtimeState.flushEventSink(source.sessionId)
    if (
      parent.lease.runtimeFence !== source.expectedRuntimeFence ||
      session.journal.cursor().epoch !== source.expectedEpoch
    ) {
      return { refusal: refuse('stale-epoch') }
    }
    const blocked = conversationCommandBlocked(
      { sessionId: source.sessionId, journal: session.journal, adapter: context.deps.adapter },
      parent
    )
    if (blocked || session.journal.isReadOnly) {
      return { refusal: refuse('busy') }
    }
    const head = agentSessionProviderHandleChainHead(parent.providerHandleChain)?.handle
    if (!head) {
      return { refusal: refuse('invalid-target') }
    }
    const selected = selectAgentSessionPrefix({
      ...session.journal.snapshot(),
      itemId: source.itemId,
      handle: head,
      boundary: 'through'
    })
    if (!selected.ok) {
      return { refusal: refuse(selected.reason) }
    }
    const retained = selected.retained.map(({ itemId, body, observedAt }) => ({
      itemId,
      body: restoreRewindJournalBody(body),
      observedAt
    }))
    try {
      forkJournalSeed(retained, head, head)
    } catch {
      return { refusal: refuse('unsupported') }
    }
    fork = {
      sourceSessionId: source.sessionId,
      operationId: params.envelope.clientOperationId,
      callerKey: caller.callerKey,
      itemId: source.itemId,
      expectedEpoch: source.expectedEpoch,
      expectedRuntimeFence: source.expectedRuntimeFence,
      source: head,
      throughId: selected.throughId,
      phase: 'prepared',
      retained
    }
  }
  const attach: AgentSessionAttachParams = {
    ...params,
    accountHome: pinned.accountHome,
    options: pinned.options,
    launchArgs: pinned.launchArgs,
    fork
  }
  attach.envelope = {
    ...params.envelope,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId: params.envelope.sessionId,
      fields: attachFingerprintFields(attach)
    })
  }
  return { attach, fork, restartRefused: prior?.phase === 'refused' }
}

function refuse(reason: AgentSessionRewindReason): AgentSessionMutationResult<never> {
  return {
    ok: false,
    refusal: {
      code: 'agent_session_operation_invalid',
      message: `agent_session_fork:${reason}`,
      forkReason: reason
    }
  }
}
