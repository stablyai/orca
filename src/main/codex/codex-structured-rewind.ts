import { readCodexThreadId, readCodexTurnId } from './codex-structured-thread-facts'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CODEX_RESTORE_MAX_OPERATIONS } from './codex-structured-journal-translation-restore'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from '../native-chat/agent-session-wire/agent-session-history-page-bounds'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'

const MAX_PAGES = 100
const MAX_ENTRIES = CODEX_RESTORE_MAX_OPERATIONS

class CodexRewindTargetRetainedError extends Error {}
class CodexRewindTargetMissingError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent_session_rewind:invalid-provider-response')
  }
  return value as Record<string, unknown>
}

function cursor(value: unknown): string | null {
  if (value === null || (typeof value === 'string' && value.length > 0)) {
    return value
  }
  throw new Error('agent_session_rewind:invalid-provider-cursor')
}

/** Read both indexes to completion before accepting the retained history. */
export async function verifyCodexRevertedHistory(
  session: Pick<CodexSession, 'connection' | 'threadId'>,
  reply: Record<string, unknown>,
  beforeTurnId: string,
  timeoutMs?: number,
  targetPresence: 'absent' | 'present' = 'absent'
): Promise<{ identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[]> {
  let bytes = 0
  let entries = 0
  const turns = new Map<string, { id: string; items: unknown[] }>()
  for (const [method, firstCursor] of [
    ['thread/turns/list', cursor(reply.turnsBackwardsCursor)],
    ['thread/items/list', cursor(reply.itemsBackwardsCursor)]
  ] as const) {
    let next = firstCursor
    const seen = new Set<string>()
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES || (next !== null && seen.has(next))) {
        throw new Error('agent_session_rewind:history-limit')
      }
      if (next !== null) {
        seen.add(next)
      }
      const result = record(
        await session.connection.request(
          method,
          {
            threadId: session.threadId,
            cursor: next,
            sortDirection: 'desc',
            limit: AGENT_SESSION_HISTORY_MAX_LIMIT
          },
          { timeoutMs }
        )
      )
      if (!Array.isArray(result.data)) {
        throw new Error('agent_session_rewind:invalid-provider-page')
      }
      bytes += Buffer.byteLength(JSON.stringify(result), 'utf8')
      entries += result.data.length
      if (bytes > AGENT_SESSION_HISTORY_MAX_PAGE_BYTES || entries > MAX_ENTRIES) {
        throw new Error('agent_session_rewind:history-limit')
      }
      for (const raw of result.data) {
        const item = record(raw)
        const turnId = method === 'thread/turns/list' ? item.id : item.turnId
        if (turnId === beforeTurnId && targetPresence === 'absent') {
          throw new CodexRewindTargetRetainedError('agent_session_rewind:target-retained')
        }
        if (typeof turnId !== 'string' || !turnId) {
          throw new Error('agent_session_rewind:invalid-retained-turn')
        }
        if (method === 'thread/turns/list') {
          if (turns.has(turnId)) {
            throw new Error('agent_session_rewind:duplicate-retained-turn')
          }
          turns.set(turnId, { id: turnId, items: [] })
        } else {
          const turn = turns.get(turnId)
          if (!turn) {
            throw new Error('agent_session_rewind:foreign-retained-item')
          }
          turn.items.push(record(item.item))
        }
      }
      next = cursor(result.nextCursor)
      if (next === null) {
        break
      }
    }
  }
  if (targetPresence === 'present' && !turns.has(beforeTurnId)) {
    throw new CodexRewindTargetMissingError('agent_session_rewind:target-missing')
  }
  const items = new Map<
    string,
    { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }
  >()
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: (identity, body) => {
        items.set(agentJournalItemKey(identity), { identity, body })
      },
      appendTombstone: (identity) => {
        items.delete(agentJournalItemKey(identity))
      },
      publish: () => {}
    },
    primaryThreadId: () => session.threadId
  })
  try {
    const chronological = [...turns.values()].toReversed()
    const retained =
      targetPresence === 'present'
        ? chronological.slice(
            0,
            chronological.findIndex((turn) => turn.id === beforeTurnId)
          )
        : chronological
    const admission = translator.restoreThread(session.threadId, {
      turns: retained.map((turn) => ({ ...turn, items: turn.items.toReversed() }))
    })
    if (!admission.accepted) {
      throw new Error('agent_session_rewind:history-unreadable')
    }
    return [...items.values()]
  } finally {
    translator.dispose()
  }
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

export async function recoverCodexRewind(
  session: CodexSession,
  input: { fence: number; beforeTurnId: string },
  timeoutMs?: number
): ReturnType<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>> {
  const admission = await preflightCodexRewind(session, input.fence, timeoutMs)
  if (!admission.ok) {
    return admission
  }
  try {
    const items = await verifyCodexRevertedHistory(
      session,
      { turnsBackwardsCursor: null, itemsBackwardsCursor: null },
      input.beforeTurnId,
      timeoutMs
    )
    if (session.fence !== input.fence || session.ended) {
      return { ok: false, reason: 'invalid-target' }
    }
    if (session.activeTurnIds?.size || session.dispatchPending) {
      return { ok: false, reason: 'busy' }
    }
    return { ok: true, items }
  } catch (error) {
    if (error instanceof CodexRewindTargetRetainedError) {
      return { ok: false, reason: 'provider-refused' }
    }
    throw error
  }
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
  let expectedItems: Set<string>
  try {
    const retained = await verifyCodexRevertedHistory(
      session,
      { turnsBackwardsCursor: null, itemsBackwardsCursor: null },
      input.beforeTurnId,
      timeoutMs,
      'present'
    )
    expectedItems = new Set(retained.map(({ identity }) => agentJournalItemKey(identity)))
    await input.onPrepared?.(retained)
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof CodexRewindTargetMissingError
          ? 'invalid-target'
          : error instanceof Error && error.message === 'agent_session_rewind:history-limit'
            ? 'history-limit'
            : 'provider-refused'
    }
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
  const reply = record(result)
  if (record(reply.thread).id !== session.threadId) {
    throw new Error('agent_session_rewind:foreign-thread')
  }
  await input.onReverted?.()
  const items = await verifyCodexRevertedHistory(session, reply, input.beforeTurnId, timeoutMs)
  if (
    items.length !== expectedItems.size ||
    items.some(({ identity }) => !expectedItems.has(agentJournalItemKey(identity)))
  ) {
    throw new Error('agent_session_rewind:proof-mismatch')
  }
  return { ok: true, items }
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
  }
}
