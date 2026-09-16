import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { recoverCodexRewind, rewindCodexSession } from './codex-structured-rewind'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from '../native-chat/agent-session-wire/agent-session-history-page-bounds'
import { openCodexThread } from './codex-structured-thread-open'

function fixture(reverted = true) {
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'thread/read') {
      return { thread: { id: 'thread', historyMode: 'paginated', status: { type: 'idle' } } }
    }
    if (method === 'thread/revert') {
      reverted = true
      return {
        thread: { id: 'thread', turns: [] },
        turnsBackwardsCursor: 'turn-cursor',
        itemsBackwardsCursor: 'item-cursor'
      }
    }
    if (method === 'thread/turns/list') {
      return { data: [...(reverted ? [] : [{ id: 'drop' }]), { id: 'kept' }], nextCursor: null }
    }
    return {
      data: [
        {
          turnId: 'kept',
          item: {
            id: 'item-1',
            type: 'userMessage',
            content: [{ type: 'text', text: 'kept prompt' }]
          }
        }
      ],
      nextCursor: null
    }
  })
  const session = {
    connection: { request },
    threadId: 'thread',
    fence: 2,
    ended: false,
    historyMode: 'paginated',
    activeTurnIds: new Set()
  } as unknown as CodexSession
  return { request, session }
}

describe('Codex rewind', () => {
  it('recovers verified history from fresh cursors without repeating revert', async () => {
    const { session, request } = fixture()
    expect(await recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop' })).toMatchObject({
      ok: true,
      items: [{ body: { kind: 'message', blocks: [{ type: 'text', text: 'kept prompt' }] } }]
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'thread/read',
      'thread/turns/list',
      'thread/items/list'
    ])
    for (const method of ['thread/turns/list', 'thread/items/list']) {
      expect(request).toHaveBeenCalledWith(
        method,
        expect.objectContaining({ cursor: null, sortDirection: 'desc' }),
        expect.anything()
      )
    }
  })
  it('recognizes an unapplied rewind from the still-present target', async () => {
    const { session, request } = fixture()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) =>
      method === 'thread/turns/list'
        ? { data: [{ id: 'drop' }, { id: 'kept' }], nextCursor: null }
        : original(method)
    )
    expect(await recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'provider-refused'
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
  })
  it.each(['cycle', 'pages', 'entries', 'bytes'] as const)(
    'bounds recovery by %s and never returns partial history',
    async (limit) => {
      const { session, request } = fixture()
      const original = request.getMockImplementation()!
      let pages = 0
      request.mockImplementation(async (method) => {
        if (method !== 'thread/turns/list') {
          return original(method)
        }
        pages++
        if (limit === 'entries') {
          return {
            data: Array.from({ length: 1025 }, (_, i) => ({ id: String(i) })),
            nextCursor: null
          }
        }
        if (limit === 'bytes') {
          return {
            data: [],
            padding: 'x'.repeat(AGENT_SESSION_HISTORY_MAX_PAGE_BYTES),
            nextCursor: null
          }
        }
        return { data: [], nextCursor: limit === 'cycle' ? 'repeated' : String(pages) }
      })
      await expect(recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop' })).rejects.toThrow(
        'history-limit'
      )
      expect(pages).toBeLessThanOrEqual(100)
      expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
    }
  )
  it('keeps an interrupted recovery retryable with read-only requests', async () => {
    const { session, request } = fixture()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) => {
      if (method === 'thread/items/list') {
        throw new Error('offline')
      }
      return original(method)
    })
    await expect(recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop' })).rejects.toThrow(
      'offline'
    )
    request.mockImplementation(original)
    expect(await recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop' })).toMatchObject({
      ok: true
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
  })
  it('refuses activity arriving during recovery hydration', async () => {
    const { session, request } = fixture()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) => {
      if (method === 'thread/items/list') {
        session.activeTurnIds!.add('racing-turn')
      }
      return original(method)
    })
    expect(await recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'busy'
    })
  })
  it('uses native revert and reads both retained indexes despite empty response turns', async () => {
    const { session, request } = fixture(false)
    const onPrepared = vi.fn<NonNullable<Parameters<typeof rewindCodexSession>[1]['onPrepared']>>(
      async (items) => {
        expect(items).toMatchObject([{ identity: { turnId: 'kept' } }])
        expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
      }
    )
    expect(
      await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop', onPrepared })
    ).toMatchObject({
      ok: true,
      items: [{ body: { kind: 'message' } }]
    })
    expect(onPrepared).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      'thread/revert',
      { threadId: 'thread', beforeTurnId: 'drop' },
      { timeoutMs: undefined }
    )
    expect(request).toHaveBeenCalledWith(
      'thread/turns/list',
      expect.objectContaining({ cursor: 'turn-cursor', sortDirection: 'desc' }),
      expect.anything()
    )
    expect(request).toHaveBeenCalledWith(
      'thread/items/list',
      expect.objectContaining({ cursor: 'item-cursor', sortDirection: 'desc' }),
      expect.anything()
    )
  })
  it('refuses a known legacy thread before making a request', async () => {
    const { session, request } = fixture()
    session.historyMode = 'legacy'
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'history-not-paginated'
    })
    expect(request).not.toHaveBeenCalled()
  })
  it('refuses history exceeding hydration capacity before mutating the provider', async () => {
    const { session, request } = fixture(false)
    const original = request.getMockImplementation()!
    const turns = Array.from({ length: 600 }, (_, i) => String(i))
    request.mockImplementation(async (method) => {
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'drop' }, ...turns.map((id) => ({ id }))], nextCursor: null }
      }
      if (method === 'thread/items/list') {
        return {
          data: turns.map((turnId) => ({
            turnId,
            item: { id: turnId, type: 'userMessage', content: [{ type: 'text', text: 'x' }] }
          })),
          nextCursor: null
        }
      }
      return original(method)
    })
    const onReverted = vi.fn()
    expect(
      await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop', onReverted })
    ).toEqual({ ok: false, reason: 'history-limit' })
    expect(onReverted).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
  })
  it('refuses a missing target before mutation', async () => {
    const { session, request } = fixture()
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'missing' })).toEqual({
      ok: false,
      reason: 'invalid-target'
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
  })
  it('rechecks provider idleness after preflight hydration', async () => {
    const { session, request } = fixture(false)
    const original = request.getMockImplementation()!
    let reads = 0
    request.mockImplementation(async (method) => {
      if (method === 'thread/read' && ++reads === 2) {
        return { thread: { id: 'thread', status: { type: 'active' } } }
      }
      return original(method)
    })
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'busy'
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
  })
  it('maps native legacy refusal without exposing provider text or falling back', async () => {
    const { session, request } = fixture(false)
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return { thread: { id: 'thread', status: { type: 'idle' } } }
      }
      if (method !== 'thread/revert') {
        return original(method)
      }
      throw new CodexAppServerRequestError(
        'thread/revert',
        -32600,
        'thread/revert only supports paginated threads'
      )
    })
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'history-not-paginated'
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'thread/read',
      'thread/turns/list',
      'thread/items/list',
      'thread/read',
      'thread/revert'
    ])
  })
  it('refuses activity arriving during the preflight await', async () => {
    const { session, request } = fixture()
    request.mockImplementationOnce(async () => {
      session.activeTurnIds!.add('racing-turn')
      return { thread: { id: 'thread', status: { type: 'idle' } } }
    })
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'busy'
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('treats hydration failure after revert as unknown and never retries revert', async () => {
    const { session, request } = fixture(false)
    const original = request.getMockImplementation()!
    let reverted = false
    request.mockImplementation(async (method) => {
      if (method === 'thread/revert') {
        reverted = true
      }
      if (method === 'thread/items/list' && reverted) {
        throw new Error('offline')
      }
      return original(method)
    })
    await expect(rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).rejects.toThrow(
      'offline'
    )
    expect(request.mock.calls.filter(([method]) => method === 'thread/revert')).toHaveLength(1)
  })
  it('captures history mode at both start and resume without changing defaults', async () => {
    for (const resumeThreadId of [null, 'thread']) {
      const request = vi.fn(async (_method: string, _params?: unknown) => ({
        thread: { id: 'thread', historyMode: 'legacy' }
      }))
      expect(
        await openCodexThread({ request }, { cwd: '/workspace', resumeThreadId }, 10)
      ).toMatchObject({ historyMode: 'legacy' })
      expect(request.mock.calls[0]?.[1]).not.toHaveProperty('historyMode')
    }
  })
  it('rejects post-revert history missing an item within a retained turn', async () => {
    const { session, request } = fixture(false)
    const original = request.getMockImplementation()!
    let reverted = false
    request.mockImplementation(async (method) => {
      if (method === 'thread/revert') {
        reverted = true
      }
      if (method === 'thread/items/list' && !reverted) {
        return {
          data: [2, 1].map((i) => ({
            turnId: 'kept',
            item: {
              id: `item-${i}`,
              type: 'userMessage',
              content: [{ type: 'text', text: `prompt ${i}` }]
            }
          })),
          nextCursor: null
        }
      }
      return original(method)
    })
    await expect(rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).rejects.toThrow(
      'proof-mismatch'
    )
  })
})
