import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { recoverCodexRewind, rewindCodexSession } from './codex-structured-rewind'
import { openCodexThread } from './codex-structured-thread-open'

/** A Codex thread whose turns are `turns`, newest last; revert drops `drop` and every later one. */
function fixture(turns = ['kept', 'drop'], reverted = false) {
  let history = reverted ? turns.slice(0, turns.indexOf('drop')) : turns
  const request = vi.fn(
    async (
      method: string,
      params?: { cursor?: string | null; limit?: number }
    ): Promise<unknown> => {
      if (method === 'thread/read') {
        return { thread: { id: 'thread', historyMode: 'paginated', status: { type: 'idle' } } }
      }
      if (method === 'thread/revert') {
        history = history.slice(0, history.indexOf('drop'))
        return { thread: { id: 'thread', turns: [] }, turnsBackwardsCursor: 'turn-cursor' }
      }
      if (method === 'thread/turns/list') {
        const newest = history.toReversed()
        const start = Number(params?.cursor ?? 0)
        const end = start + (params?.limit ?? newest.length)
        return {
          data: newest.slice(start, end).map((id) => ({ id })),
          nextCursor: end < newest.length ? String(end) : null
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  )
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

const methods = (request: ReturnType<typeof fixture>['request']) =>
  request.mock.calls.map(([method]) => method)

describe('Codex rewind', () => {
  it('rewinds a long chat reading only the turns it undoes, and trusts the revert', async () => {
    const turns = [...Array.from({ length: 5_000 }, (_, i) => `t${i}`), 'drop']
    turns.push(...Array.from({ length: 250 }, (_, i) => `later${i}`))
    const { session, request } = fixture(turns)
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: true
    })
    expect(methods(request)).toEqual([
      'thread/read',
      'thread/turns/list',
      'thread/turns/list',
      'thread/read',
      'thread/revert'
    ])
    expect(request).toHaveBeenCalledWith(
      'thread/revert',
      { threadId: 'thread', beforeTurnId: 'drop' },
      { timeoutMs: undefined }
    )
  })
  it('recovers an applied revert from the newest turn alone', async () => {
    const turns = [...Array.from({ length: 5_000 }, (_, i) => `t${i}`), 'drop', 'after']
    const { session, request } = fixture(turns, true)
    expect(
      await recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop', keptTurnId: 't4999' })
    ).toEqual({ ok: true })
    expect(methods(request)).toEqual(['thread/read', 'thread/turns/list'])
  })
  it('recovers an unapplied revert from the still-present target, never repeating it', async () => {
    const { session, request } = fixture(['kept', 'drop', 'after'])
    expect(
      await recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop', keptTurnId: 'kept' })
    ).toEqual({ ok: false, reason: 'provider-refused' })
    expect(methods(request)).not.toContain('thread/revert')
  })
  it('never calls a revert applied when the history does not end at the kept turn', async () => {
    const { session } = fixture(['other', 'kept', 'foreign'])
    await expect(
      recoverCodexRewind(session, { fence: 2, beforeTurnId: 'drop', keptTurnId: 'kept' })
    ).rejects.toThrow('outcome-unknown')
  })
  it('recovers a rewind to the first turn only from an emptied history', async () => {
    expect(
      await recoverCodexRewind(fixture(['drop'], true).session, {
        fence: 2,
        beforeTurnId: 'drop',
        keptTurnId: null
      })
    ).toEqual({ ok: true })
    await expect(
      recoverCodexRewind(fixture(['foreign']).session, {
        fence: 2,
        beforeTurnId: 'drop',
        keptTurnId: null
      })
    ).rejects.toThrow('outcome-unknown')
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
  it('refuses a missing target before mutation', async () => {
    const { session, request } = fixture()
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'missing' })).toEqual({
      ok: false,
      reason: 'invalid-target'
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
  })
  it('rechecks provider idleness after preflight hydration', async () => {
    const { session, request } = fixture()
    const original = request.getMockImplementation()!
    let reads = 0
    request.mockImplementation(async (method, params) => {
      if (method === 'thread/read' && ++reads === 2) {
        return { thread: { id: 'thread', status: { type: 'active' } } }
      }
      return original(method, params)
    })
    expect(await rewindCodexSession(session, { fence: 2, beforeTurnId: 'drop' })).toEqual({
      ok: false,
      reason: 'busy'
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false)
  })
  it('maps native legacy refusal without exposing provider text or falling back', async () => {
    const { session, request } = fixture()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') {
        return { thread: { id: 'thread', status: { type: 'idle' } } }
      }
      if (method !== 'thread/revert') {
        return original(method, params)
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
})
