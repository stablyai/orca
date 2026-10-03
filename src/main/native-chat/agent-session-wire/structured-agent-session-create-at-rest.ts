// Creating a chat: its record and its journal, at rest. No agent starts here. The chat's first
// message starts one (`structured-agent-session-agent-start`), so a start that fails is reported
// on that message and never fails the create.

import { refuse } from '../../../shared/agent-session-wire-refusals'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  adoptedProviderHandleLink,
  admitAttachOrRefuse,
  classifyStoreFailure,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { adapterSupportsCreateIfDeclared } from './structured-agent-session-provider-support'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { pinnedAgentSessionLaunchArgs } from './structured-agent-session-launch-env'
import {
  importAdoptedTranscript,
  prepareAdoptedTranscript
} from './structured-agent-session-adopted-import'

type CreateResult = AgentSessionMutationResult<AgentSessionAttachResult>

export function createStructuredAgentSessionAtRest(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<CreateResult> {
  // Tracked from enqueue: a quit drains a create before it closes conversations, so none it opens
  // is left open behind the teardown.
  return context.tasks.trackAttach(
    context.serialize(params.envelope.sessionId, () => createAtRest(context, callerKey, params))
  )
}

async function createAtRest(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<CreateResult> {
  const { store, adapter } = context.deps
  const sessionId = params.envelope.sessionId
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }
  if (!adapterSupportsCreateIfDeclared(adapter, params.location, params.agent)) {
    return {
      ok: false,
      refusal: refuse(
        'structured_agent_session_unsupported',
        { reason: 'hostUnsupported' },
        'This execution host cannot create the requested structured agent session.'
      )
    }
  }
  // A record this host has not adjudicated since load is adjudicated here, as a start does: the
  // create's transaction refuses one still unreconciled, and nothing else on this path would clear it.
  if (store.getRecord(sessionId)?.lease.unreconciled) {
    const unreconciled = await context.reconcileLeases(sessionId)
    if (unreconciled) {
      return { ok: false, refusal: unreconciled }
    }
  }
  // Read and checked before the record claims the provider conversation it adopts.
  const transcript = store.getRecord(sessionId)
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!transcript.ok) {
    return transcript
  }
  let created: Awaited<ReturnType<typeof store.createAtRest>>
  try {
    const now = context.now()
    created = await store.createAtRest({
      sessionId,
      location: params.location,
      provider: params.provider,
      accountHome: params.accountHome,
      ...(params.options ? { options: params.options } : {}),
      ...(params.surfaceTabId ? { surfaceTabId: params.surfaceTabId } : {}),
      ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
      ...(params.adopt
        ? { adoptedHandleLink: adoptedProviderHandleLink(params.adopt.providerHandle, now) }
        : {}),
      claimKeyId: context.deps.claimKeyId,
      operation: {
        callerKey,
        operationId: params.envelope.clientOperationId,
        fingerprint: admitted.fingerprint
      },
      now
    })
  } catch (error) {
    return { ok: false, refusal: classifyStoreFailure(error, null, store.getRecord(sessionId)) }
  }
  // Settled only once the journal is open and any adopted history is in it. A create that stopped
  // short (a throw, a crash, a quit) leaves its row pending, and its replay does that work again:
  // the import is a no-op on a journal that already holds rows.
  const settled = created.operationRow.outcome.status === 'succeeded'
  if (created.replayed && !settled) {
    // `failed` or `unknown` rows are a create from before chats were created at rest.
    const replay = resolveAgentSessionReplayOutcome({
      operationId: params.envelope.clientOperationId,
      outcome: created.operationRow.outcome,
      reconstruct: () => null
    })
    if (replay.decision === 'refuse') {
      return { ok: false, refusal: replay.refusal }
    }
  }
  const conversation = await context.openConversation(created.record.sessionId)
  if (!conversation) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_identity_required',
        { reason: 'recordMissing' },
        'No structured session exists by that id.'
      )
    }
  }
  const { journal } = conversation
  if (!settled) {
    await importAdoptedTranscript(
      params,
      { journal, unconfirmedClientMessageIds: [] },
      created.record,
      transcript.items
    )
    await store.recordOperationOutcome({
      callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'succeeded', sessionId: created.record.sessionId }
    })
  }
  const fence = created.record.lease.runtimeFence
  const tabId = store.getSessionTabId(created.record.sessionId)
  return {
    ok: true,
    replayed: created.replayed,
    fence,
    cursor: journal.cursor(),
    value: {
      sessionId: created.record.sessionId,
      fence,
      page: readAgentSessionHydrationPage(journal, fence),
      unconfirmedClientMessageIds: [],
      ...(tabId ? { tabId } : {})
    }
  }
}
