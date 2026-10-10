import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  refuse,
  type AgentSessionAttachResult,
  type AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { journalOpenRefusalError } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { reserveRequestFor, type AgentSessionAttachParams } from './structured-agent-session-attach'
import { openStructuredAgentSessionConversationJournal } from './structured-agent-session-conversation-open'
import {
  prepareAdoptedTranscript,
  importAdoptedTranscript
} from './structured-agent-session-adopted-import'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import {
  adapterSupportsCreateIfDeclared,
  hostCanStartRecord
} from './structured-agent-session-provider-support'
import { performSend } from './structured-agent-session-turns'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'

export type StructuredAgentSessionCreateOptions = {
  firstMessage?: { clientMessageId: string; body: AgentJournalMessageItem }
  hostLaunchDirectory?: string
  /** Called after the durable create, before delivery can start the agent. */
  publishTab?: () => Promise<void>
}

/** Founds a chat and its opening message; only the delivery loop acquires the agent. */
export function createStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionCreateOptions = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return context.tasks.trackAttach(
    context.serialize(params.envelope.sessionId, async () => {
      try {
        return await foundConversation(context, callerKey, params, options)
      } catch (error) {
        if (isAgentSessionRefusalError(error)) {
          return { ok: false, refusal: error.refusal }
        }
        throw error
      }
    })
  )
}

async function foundConversation(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionCreateOptions
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { deps } = context
  const { store } = deps
  const sessionId = params.envelope.sessionId
  const prior = store.getRecord(sessionId)
  if (params.envelope.expectedRuntimeFence !== null || params.agent !== params.provider) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        'The create request is malformed.'
      )
    }
  }
  if (
    prior
      ? !hostCanStartRecord(deps, prior)
      : !deps.agents.definition(params.agent) ||
        !adapterSupportsCreateIfDeclared(deps.adapter, params.location, params.agent)
  ) {
    return {
      ok: false,
      refusal: refuse(
        'structured_agent_session_unsupported',
        { reason: 'hostUnsupported' },
        'This execution host cannot create the requested chat.'
      )
    }
  }
  const launchDirectory =
    !prior && isFloatingWorkspaceId(params.location.workspaceId)
      ? (options.hostLaunchDirectory ??
        (await deps.resolveWorkspacePath?.(params.location.workspaceId)))
      : undefined
  if (!prior && isFloatingWorkspaceId(params.location.workspaceId) && !launchDirectory) {
    throw new Error('floating_agent_session_launch_directory_unavailable')
  }
  const request = reserveRequestFor({
    sessionId,
    params,
    callerKey,
    fingerprint: params.envelope.payloadFingerprint,
    now: context.now(),
    authority: {
      ...(launchDirectory ? { launchDirectory } : {}),
      spawnToken: () => {
        throw new Error('founding_must_not_reserve_a_spawn')
      },
      claimKeyId: deps.claimKeyId,
      handoffOperationId: null,
      probe: { outcome: 'pid-absent' },
      ...(await pinnedAgentSessionLaunchArgs(deps.resolveLaunchArgs, params)),
      ...(await pinnedAgentSessionLaunchEnv(deps.resolveLaunchEnv, params))
    }
  })
  const candidate = store.founding.prepare(request)
  if (!hostCanStartRecord(deps, candidate.record)) {
    return {
      ok: false,
      refusal: refuse(
        'structured_agent_session_unsupported',
        { reason: 'hostUnsupported' },
        'This execution host cannot create the requested structured agent session.'
      )
    }
  }
  const replayed = candidate.disposition === 'replayed'
  if (replayed && candidate.operationRow.outcome.status !== 'succeeded') {
    const replay = resolveAgentSessionReplayOutcome({
      operationId: params.envelope.clientOperationId,
      outcome: candidate.operationRow.outcome,
      reconstruct: () => null
    })
    return {
      ok: false,
      refusal:
        replay.decision === 'refuse'
          ? replay.refusal
          : refuse(
              'agent_session_operation_unknown',
              { reason: 'outcomeUnknown' },
              'The create outcome is unknown.'
            )
    }
  }
  const prepared = replayed
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!prepared.ok) {
    return prepared
  }
  const existing = context.sessions.get(sessionId)
  const opened = existing
    ? { session: existing }
    : await openStructuredAgentSessionConversationJournal(deps, candidate.record).catch(
        (error: unknown) => {
          deps.logger.warn('opening the journal of a new chat failed', {
            scope: 'create-journal-open',
            sessionId,
            error
          })
          throw journalOpenRefusalError(error)
        }
      )
  const { session } = opened
  const fence = candidate.record.lease.runtimeFence
  let committed = replayed
  try {
    if (!replayed) {
      await importAdoptedTranscript(
        params,
        { journal: session.journal, unconfirmedClientMessageIds: [] },
        candidate.record,
        prepared.items,
        { uncommittedCreate: true }
      )
      const first = options.firstMessage
      if (first) {
        const sent = await performSend(
          {
            sessionId,
            journal: session.journal,
            fence,
            adapter: deps.adapter,
            agents: deps.agents,
            agent: params.agent,
            logger: deps.logger,
            resolvedBy: callerKey,
            persistOptions: async () => {},
            publish: () => {},
            operationReceipt: store.founding.receipt(request),
            now: context.now
          },
          {
            ...first,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId,
              fields: { body: first.body }
            }),
            origin: 'client',
            source: { kind: 'user' }
          }
        )
        if (!sent.ok) {
          return sent
        }
      } else {
        await store.founding.commit(request)
      }
      committed = true
    }
    try {
      await options.publishTab?.()
    } catch (error) {
      deps.logger.warn('publishing the tab of a created chat failed', {
        scope: 'create-tab-publication',
        sessionId,
        error
      })
      if (!existing) {
        context.sessions.set(sessionId, session)
      }
      return {
        ok: false,
        refusal: refuse(
          'agent_session_operation_unknown',
          { reason: 'tabUnconfirmed' },
          'The chat may have been created, but its tab could not be confirmed.'
        )
      }
    }
    if (!existing) {
      context.sessions.set(sessionId, session)
    }
    context.publishStatus(sessionId)
    const tabId = store.getSessionTabId(sessionId)
    const firstMessage = options.firstMessage
      ? session.journal.submission(options.firstMessage.clientMessageId)
      : undefined
    const result = {
      ok: true as const,
      replayed,
      fence,
      cursor: session.journal.cursor(),
      value: {
        sessionId,
        fence,
        page: readAgentSessionHydrationPage(session.journal, fence),
        unconfirmedClientMessageIds: [],
        ...(firstMessage ? { firstMessage } : {}),
        ...(tabId ? { tabId } : {})
      }
    }
    context.wakeDelivery?.(sessionId)
    return result
  } finally {
    if (!committed && !existing) {
      await session.journal.close()
    }
  }
}

/** Host entry points that open a chat: attach an existing one or create a new one. */
export function structuredAgentSessionEntryDelegates(
  context: () => StructuredAgentSessionAttachContext
) {
  return {
    attach: (
      caller: StructuredAgentSessionCaller,
      params: AgentSessionAttachParams,
      options?: Parameters<typeof attachStructuredAgentSession>[3]
    ) => attachStructuredAgentSession(context(), caller.callerKey, params, options),
    create: (
      caller: StructuredAgentSessionCaller,
      params: AgentSessionAttachParams,
      options?: StructuredAgentSessionCreateOptions
    ) => createStructuredAgentSession(context(), caller.callerKey, params, options)
  }
}
