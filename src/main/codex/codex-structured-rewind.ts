import { readCodexThreadId, readCodexTurnId } from './codex-structured-thread-facts'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../shared/agent-session-wire'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent_session_rewind:invalid-provider-response')
  }
  return value as Record<string, unknown>
}

function cursor(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new Error('agent_session_rewind:invalid-provider-cursor')
}

/** Stop paging at the target so rewind cost depends on the undone tail, not total chat length. */
async function findInCodexTurnsNewestFirst<T>(
  session: Pick<CodexSession, 'connection' | 'threadId'>,
  visit: (turnId: string, index: number) => T | undefined,
  timeoutMs?: number
): Promise<T | undefined> {
  let next: string | null = null
  const seen = new Set<string>()
  let index = 0
  do {
    if (next !== null) {
      if (seen.has(next)) {
        throw new Error('agent_session_rewind:invalid-provider-cursor')
      }
      seen.add(next)
    }
    const page = record(
      await session.connection.request(
        'thread/turns/list',
        {
          threadId: session.threadId,
          cursor: next,
          sortDirection: 'desc',
          limit: AGENT_SESSION_HISTORY_MAX_LIMIT
        },
        { timeoutMs }
      )
    )
    if (!Array.isArray(page.data)) {
      throw new Error('agent_session_rewind:invalid-provider-page')
    }
    for (const raw of page.data) {
      const turnId = record(raw).id
      if (typeof turnId !== 'string' || !turnId) {
        throw new Error('agent_session_rewind:invalid-retained-turn')
      }
      const answer = visit(turnId, index++)
      if (answer !== undefined) {
        return answer
      }
    }
    next = cursor(page.nextCursor)
  } while (next !== null)
  return undefined
}

async function preflightCodexRewind(
  session: CodexSession,
  fence: number,
  timeoutMs?: number
): Promise<
  { ok: true } | { ok: false; reason: 'invalid-target' | 'history-not-paginated' | 'busy' }
> {
  if (session.fence !== fence || session.ended) {
    return { ok: false, reason: 'invalid-target' }
  }
  if (session.historyMode === 'legacy') {
    return { ok: false, reason: 'history-not-paginated' }
  }
  if (session.activeTurnIds?.size || session.dispatchPending) {
    return { ok: false, reason: 'busy' }
  }
  const metadata = record(
    await session.connection.request(
      'thread/read',
      { threadId: session.threadId, includeTurns: false },
      { timeoutMs }
    )
  )
  const thread = record(metadata.thread)
  if (thread.id !== session.threadId) {
    return { ok: false, reason: 'invalid-target' }
  }
  if (thread.historyMode === 'legacy') {
    session.historyMode = 'legacy'
    return { ok: false, reason: 'history-not-paginated' }
  }
  if (
    record(thread.status).type !== 'idle' ||
    session.activeTurnIds?.size ||
    session.dispatchPending
  ) {
    return { ok: false, reason: 'busy' }
  }
  if (session.fence !== fence || session.ended) {
    return { ok: false, reason: 'invalid-target' }
  }
  return { ok: true }
}

/** Confirm a lost revert reply only when history ends at the expected retained turn. */
export async function recoverCodexRewind(
  session: CodexSession,
  input: { fence: number; beforeTurnId: string; keptTurnId: string | null },
  timeoutMs?: number
): ReturnType<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>> {
  const admission = await preflightCodexRewind(session, input.fence, timeoutMs)
  if (!admission.ok) {
    return admission
  }
  let turns = 0
  const verdict = await findInCodexTurnsNewestFirst(
    session,
    (turnId, index) => {
      turns++
      if (turnId === input.beforeTurnId) {
        return 'unapplied' as const
      }
      return turnId === input.keptTurnId ? index === 0 : undefined
    },
    timeoutMs
  )
  // Rewinding the first turn is confirmed only by empty history.
  const applied = verdict === true || (input.keptTurnId === null && turns === 0)
  if (!applied && verdict !== 'unapplied') {
    throw new Error('agent_session_rewind:outcome-unknown')
  }
  if (session.fence !== input.fence || session.ended) {
    return { ok: false, reason: 'invalid-target' }
  }
  if (session.activeTurnIds?.size || session.dispatchPending) {
    return { ok: false, reason: 'busy' }
  }
  return applied ? { ok: true } : { ok: false, reason: 'provider-refused' }
}

export async function rewindCodexSession(
  session: CodexSession,
  input: Omit<Parameters<NonNullable<StructuredAgentSessionAdapter['rewind']>>[0], 'sessionId'>,
  timeoutMs?: number
): ReturnType<NonNullable<StructuredAgentSessionAdapter['rewind']>> {
  const admission = await preflightCodexRewind(session, input.fence, timeoutMs)
  if (!admission.ok) {
    return admission
  }
  let targetPresent: boolean | undefined
  try {
    targetPresent = await findInCodexTurnsNewestFirst(
      session,
      (turnId) => (turnId === input.beforeTurnId ? true : undefined),
      timeoutMs
    )
  } catch {
    return { ok: false, reason: 'provider-refused' }
  }
  if (!targetPresent) {
    return { ok: false, reason: 'invalid-target' }
  }
  const current = await preflightCodexRewind(session, input.fence, timeoutMs)
  if (!current.ok) {
    return current
  }
  let result: unknown
  try {
    result = await session.connection.request(
      'thread/revert',
      {
        threadId: session.threadId,
        beforeTurnId: input.beforeTurnId
      },
      { timeoutMs }
    )
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      if (error.message === 'thread/revert only supports paginated threads') {
        session.historyMode = 'legacy'
        return { ok: false, reason: 'history-not-paginated' }
      }
      if (error.code === -32601) {
        return { ok: false, reason: 'unsupported' }
      }
    }
    throw error
  }
  if (record(record(result).thread).id !== session.threadId) {
    throw new Error('agent_session_rewind:foreign-thread')
  }
  return { ok: true }
}

export function observeCodexRewindActivity(
  session: CodexSession,
  method: string,
  params: unknown
): void {
  if ((readCodexThreadId(params) ?? session.threadId) !== session.threadId) {
    return
  }
  const turnId = readCodexTurnId(params)
  if (turnId && method === 'turn/started') {
    session.activeTurnIds?.add(turnId)
  }
  if (turnId && method === 'turn/completed') {
    session.activeTurnIds?.delete(turnId)
    session.abortedTurnIds?.delete(turnId)
  }
}
