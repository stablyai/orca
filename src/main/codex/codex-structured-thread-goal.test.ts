import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { changeCodexThreadGoal, codexThreadGoalRequests } from './codex-structured-thread-goal'
import type { CodexSession } from './codex-structured-session-state'

const THREAD = 'thread-1'

function session(request: (...args: unknown[]) => Promise<unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the goal path reads only these two fields.
  return { threadId: THREAD, connection: { request } } as unknown as Pick<
    CodexSession,
    'connection' | 'threadId'
  >
}

describe('codex thread goal requests', () => {
  it('sets an objective as an active goal with no turn of its own', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'set', objective: 'Ship it' }, false)).toEqual([
      {
        method: 'thread/goal/set',
        params: { threadId: THREAD, objective: 'Ship it', status: 'active' }
      }
    ])
  })

  it('clears the existing goal before setting a new objective, so the new goal starts fresh', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'set', objective: 'Ship it' }, true)).toEqual([
      { method: 'thread/goal/clear', params: { threadId: THREAD } },
      {
        method: 'thread/goal/set',
        params: { threadId: THREAD, objective: 'Ship it', status: 'active' }
      }
    ])
  })

  it('pauses and resumes by status alone, keeping the objective', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'status', status: 'paused' }, true)).toEqual([
      { method: 'thread/goal/set', params: { threadId: THREAD, status: 'paused' } }
    ])
    expect(codexThreadGoalRequests(THREAD, { kind: 'status', status: 'active' }, true)).toEqual([
      { method: 'thread/goal/set', params: { threadId: THREAD, status: 'active' } }
    ])
  })

  it('clears with only the thread id', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'clear' }, true)).toEqual([
      { method: 'thread/goal/clear', params: { threadId: THREAD } }
    ])
  })

  it('sends each request in order with the session deadline', async () => {
    const request = vi.fn(async () => ({ goal: null }))
    await expect(
      changeCodexThreadGoal(session(request), { kind: 'set', objective: 'Ship it' }, true, 5_000)
    ).resolves.toEqual({ ok: true })
    expect(request.mock.calls).toEqual([
      ['thread/goal/clear', { threadId: THREAD }, { timeoutMs: 5_000 }],
      [
        'thread/goal/set',
        { threadId: THREAD, objective: 'Ship it', status: 'active' },
        { timeoutMs: 5_000 }
      ]
    ])
  })

  it('stops at a refused clear, so a refused replacement leaves the old goal alone', async () => {
    const request = vi.fn(async (method: unknown) => {
      if (method === 'thread/goal/clear') {
        throw new CodexAppServerRequestError('thread/goal/clear', -32600, 'goals are disabled')
      }
      return { goal: null }
    })
    await expect(
      changeCodexThreadGoal(session(request), { kind: 'set', objective: 'Ship it' }, true, 5_000)
    ).resolves.toEqual({ ok: false, rejected: 'goals are disabled' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports a provider refusal and rethrows anything that leaves the effect unknown', async () => {
    const refused = session(async () => {
      throw new CodexAppServerRequestError('thread/goal/set', -32600, 'goals feature is disabled')
    })
    await expect(
      changeCodexThreadGoal(refused, { kind: 'set', objective: 'Ship it' }, false, undefined)
    ).resolves.toEqual({ ok: false, rejected: 'goals feature is disabled' })

    const lost = session(async () => {
      throw new Error('codex app-server request timed out')
    })
    await expect(changeCodexThreadGoal(lost, { kind: 'clear' }, false, undefined)).rejects.toThrow(
      'timed out'
    )
  })
})
