import {
  prepareFoundingRequest,
  unknownFoundingOutcome,
  type StructuredAgentSessionCreateOptions
} from './structured-agent-session-founding-request'
export type { StructuredAgentSessionCreateOptions } from './structured-agent-session-founding-request'
import {
  createFoundingReceipt,
  sendOpeningFoundingMessage
} from './structured-agent-session-founding-receipt'

import { assertHostFoundingNotCancelled } from '../../agent-launch/host-founding-attempt'

import { isAgentSessionCreateAdmissionRefusal } from '../../../shared/agent-session-definitive-refusal'

import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  refuse,
  type AgentSessionAttachResult,
  type AgentSessionMutationResult
} from '../../../shared/agent-session-wire'

import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { journalOpenRefusalError } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { openStructuredAgentSessionConversationJournal } from './structured-agent-session-conversation-open'
import {
  prepareAdoptedTranscript,
  importAdoptedTranscript
} from './structured-agent-session-adopted-import'

import {
  adapterSupportsCreateIfDeclared,
  hostCanStartRecord
} from './structured-agent-session-provider-support'

import { observedReceipt } from './structured-agent-session-operation-settlement'

import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'

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
    }),
    { sessionId: params.envelope.sessionId, location: params.location }
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
  const request = await prepareFoundingRequest(context, callerKey, params, options, prior)
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
  const attempt = options.hostFoundingAttempt
  if (attempt) {
    attempt.identity = {
      callerKey,
      operationId: request.operation.operationId,
      fingerprint: request.operation.fingerprint,
      sessionId,
      priorRecord: prior !== null && prior !== undefined
    }
    attempt.disposition = replayed ? 'replay' : 'fresh'
  }
  if (replayed && candidate.operationRow.outcome.status !== 'succeeded') {
    const replay = resolveAgentSessionReplayOutcome({
      operationId: params.envelope.clientOperationId,
      outcome: candidate.operationRow.outcome,
      reconstruct: () => null
    })
    return {
      ok: false,
      refusal: replay.decision === 'refuse' ? replay.refusal : unknownFoundingOutcome()
    }
  }
  const prepared = replayed
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!prepared.ok) {
    const { refusal } = prepared
    return {
      ok: false,
      refusal: isAgentSessionCreateAdmissionRefusal(refusal)
        ? { ...refusal, createAttemptRefusedBeforeCommit: true }
        : refusal
    }
  }
  const existing = context.sessions.get(sessionId)
  // A replay token cannot prove the earlier message absent, and is not a reason to open it.
  if (attempt && replayed && options.firstMessage && !existing) {
    return {
      ok: false,
      refusal: unknownFoundingOutcome()
    }
  }
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
  let keepHandle = replayed
  const foundingReceipt = createFoundingReceipt(context, request, params, options, attempt)
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
        const receipt = observedReceipt(store, foundingReceipt(true))
        const sent = await sendOpeningFoundingMessage(
          context,
          params,
          session,
          candidate.record,
          callerKey,
          fence,
          first,
          receipt
        )
        if (!sent.ok) {
          if (!attempt) {
            return sent
          }
          assertHostFoundingNotCancelled(attempt)
          const disposition = attempt.opening?.transaction.disposition
          if (disposition === 'not-attempted' || disposition === 'not-committed') {
            await store.commitOperationReceipt(foundingReceipt(false))
          } else {
            // Publication uses adopted identity, independently of this failed new handle.
            if (attempt.adopted && disposition === 'committed') {
              await options.publishTab?.()
            }
            return {
              ok: false,
              refusal: unknownFoundingOutcome()
            }
          }
        }
      } else if (attempt) {
        await store.commitOperationReceipt(foundingReceipt(false))
      } else {
        await store.founding.commit(request)
      }
      if (attempt && !attempt.adopted) {
        return {
          ok: false,
          refusal: unknownFoundingOutcome()
        }
      }
      keepHandle = true
    }
    const firstMessage = options.firstMessage
      ? session.journal.submission(options.firstMessage.clientMessageId)
      : undefined
    if (attempt && replayed) {
      const record = store.getRecord(sessionId)
      const expectedFingerprint =
        options.firstMessage &&
        computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId,
          fields: { body: options.firstMessage.body }
        })
      if (options.firstMessage && firstMessage?.payloadFingerprint !== expectedFingerprint) {
        return {
          ok: false,
          refusal: unknownFoundingOutcome()
        }
      }
      if (record) {
        const tabId = store.getSessionTabId(sessionId)
        attempt.adopted = {
          sessionId: record.sessionId,
          workspaceId: record.location.workspaceId,
          agent: params.agent,
          fence: record.lease.runtimeFence,
          ...(tabId ? { tabId } : {})
        }
      }
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
    if (!keepHandle && !existing) {
      await (attempt
        ? session.journal.close().catch((error: unknown) => {
            deps.logger.warn('closing a failed new chat handle failed', {
              scope: 'create-journal-close',
              sessionId,
              error
            })
          })
        : session.journal.close())
    }
  }
}
