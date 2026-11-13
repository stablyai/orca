import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionRewindReason } from '../../shared/agent-session/lifecycle/agent-session-rewind'
import type { TraexSession } from './traex-session'
import { readTraexTurns } from './traex-thread-history'
import { traexRecord, traexThreadResponseSchema, TraexRequestError } from './traex-protocol'

function localRewindAdmission(
  session: TraexSession,
  fence: number
): AgentSessionRewindReason | null {
  if (
    session.input.fence !== fence ||
    session.ended ||
    session.connection.closed ||
    !session.threadId
  ) {
    return 'invalid-target'
  }
  if (session.rewindUnsupported || session.historyMode === 'legacy') {
    return 'unsupported'
  }
  return session.activeTurn || session.pending.size || session.compacting ? 'busy' : null
}

async function preflightTraexRewind(
  session: TraexSession,
  fence: number
): Promise<AgentSessionRewindReason | null> {
  const admission = localRewindAdmission(session, fence)
  if (admission) {
    return admission
  }
  const response = traexThreadResponseSchema.parse(
    await session.connection.request('thread/read', {
      threadId: session.threadId!,
      includeTurns: false
    })
  )
  if (response.thread.id !== session.threadId) {
    return 'invalid-target'
  }
  session.historyMode = response.thread.historyMode ?? session.historyMode
  if (traexRecord(response.thread.status).type !== 'idle') {
    return 'busy'
  }
  return localRewindAdmission(session, fence)
}

async function readRewindTurns(session: TraexSession, fence: number, signal?: AbortSignal) {
  return readTraexTurns(session.connection, session.threadId!, () => {
    signal?.throwIfAborted()
    if (localRewindAdmission(session, fence)) {
      throw new Error('TRAE CLI rewind state changed while reading history')
    }
  })
}

export async function prepareTraexRewind(
  session: TraexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['prepareRewind']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['prepareRewind']>> {
  const reason = await preflightTraexRewind(session, input.fence)
  if (reason) {
    return { ok: false, reason }
  }
  const turns = await readRewindTurns(session, input.fence)
  const index = turns.findIndex((turn) => turn.id === input.beforeTurnId)
  return index === -1
    ? { ok: false, reason: 'invalid-target' }
    : {
        ok: true,
        revert: {
          threadId: session.threadId!,
          beforeTurnId: input.beforeTurnId,
          keptTurnId: index > 0 ? turns[index - 1]!.id : null
        }
      }
}

export async function recoverTraexRewind(
  session: TraexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>> {
  input.signal?.throwIfAborted()
  const reason = await preflightTraexRewind(session, input.fence)
  if (reason) {
    return { ok: false, reason }
  }
  if (input.threadId && input.threadId !== session.threadId) {
    return { ok: false, reason: 'invalid-target' }
  }
  const turns = await readRewindTurns(session, input.fence, input.signal)
  if (turns.some((turn) => turn.id === input.beforeTurnId)) {
    return { ok: false, reason: 'provider-refused' }
  }
  if ((turns.at(-1)?.id ?? null) !== input.keptTurnId) {
    throw new Error('agent_session_rewind:outcome-unknown')
  }
  const changed = localRewindAdmission(session, input.fence)
  return changed ? { ok: false, reason: changed } : { ok: true }
}

export async function rewindTraexSession(
  session: TraexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['rewind']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['rewind']>> {
  const prepared = await prepareTraexRewind(session, input)
  if (!prepared.ok) {
    return prepared
  }
  let response: unknown
  try {
    response = await session.connection.request('thread/revert', {
      threadId: session.threadId!,
      beforeTurnId: input.beforeTurnId
    })
  } catch (error) {
    if (error instanceof TraexRequestError && error.code === -32601) {
      session.rewindUnsupported = true
      return { ok: false, reason: 'unsupported' }
    }
    if (
      error instanceof TraexRequestError &&
      error.message === 'thread/revert only supports paginated threads'
    ) {
      session.historyMode = 'legacy'
      return { ok: false, reason: 'unsupported' }
    }
    throw error
  }
  if (traexThreadResponseSchema.parse(response).thread.id !== session.threadId) {
    throw new Error('agent_session_rewind:foreign-thread')
  }
  return recoverTraexRewind(session, { ...input, ...prepared.revert })
}
