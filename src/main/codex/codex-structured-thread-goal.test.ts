import { describe, expect, it, vi } from 'vitest'
import { readRecord } from './codex-item-field-readers'
import { CodexAppliedSettings } from './codex-structured-applied-settings'
import { CodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { changeCodexThreadGoal, codexThreadGoalRequests } from './codex-structured-thread-goal'
import type { CodexSession } from './codex-structured-session-state'
import { waitsForCodexTurnOptions } from '../native-chat/agent-session-wire/structured-agent-session-message-options'

const THREAD = 'thread-1'

type AcquiredSettingsTestSeam = {
  settings: CodexAppliedSettings
  pending: Set<unknown>
  listeners: Set<unknown>
  readonly snapshot: Record<string, unknown>
}

function acquiredSettingsTestSeam(adapter: unknown): AcquiredSettingsTestSeam {
  const sessions = readRecord(adapter).sessions
  if (!(sessions instanceof Map)) {
    throw new Error('missing acquired sessions')
  }
  const settings = readRecord(sessions.get('session-1')).appliedSettings
  if (!(settings instanceof CodexAppliedSettings)) {
    throw new Error('missing acquired settings')
  }
  const state = readRecord(settings)
  if (!(state.pending instanceof Set) || !(state.listeners instanceof Set)) {
    throw new Error('missing acquired settings collections')
  }
  return {
    settings,
    pending: state.pending,
    listeners: state.listeners,
    get snapshot() {
      const snapshot = readRecord(settings).snapshot
      if (typeof snapshot !== 'object' || snapshot === null) {
        throw new Error('missing acquired settings snapshot')
      }
      return readRecord(snapshot)
    }
  }
}

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
        params: { threadId: THREAD, origin: 'user', objective: 'Ship it', status: 'active' }
      }
    ])
  })

  it('clears the existing goal before setting a new objective, so the new goal starts fresh', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'set', objective: 'Ship it' }, true)).toEqual([
      { method: 'thread/goal/clear', params: { threadId: THREAD, origin: 'user' } },
      {
        method: 'thread/goal/set',
        params: { threadId: THREAD, origin: 'user', objective: 'Ship it', status: 'active' }
      }
    ])
  })

  it('pauses and resumes by status alone, keeping the objective', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'status', status: 'paused' }, true)).toEqual([
      { method: 'thread/goal/set', params: { threadId: THREAD, origin: 'user', status: 'paused' } }
    ])
    expect(codexThreadGoalRequests(THREAD, { kind: 'status', status: 'active' }, true)).toEqual([
      { method: 'thread/goal/set', params: { threadId: THREAD, origin: 'user', status: 'active' } }
    ])
  })

  it('clears with user provenance', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'clear' }, true)).toEqual([
      { method: 'thread/goal/clear', params: { threadId: THREAD, origin: 'user' } }
    ])
  })

  it('sends each request in order with the session deadline', async () => {
    const request = vi.fn(async () => ({ goal: null }))
    await expect(
      changeCodexThreadGoal(session(request), { kind: 'set', objective: 'Ship it' }, true, 5_000)
    ).resolves.toEqual({ ok: true })
    expect(request.mock.calls).toEqual([
      ['thread/goal/clear', { threadId: THREAD, origin: 'user' }, { timeoutMs: 5_000 }],
      [
        'thread/goal/set',
        { threadId: THREAD, origin: 'user', objective: 'Ship it', status: 'active' },
        { timeoutMs: 5_000 }
      ]
    ])
  })

  it('awaits a revoked clear and never activates the replacement', async () => {
    const clear = Promise.withResolvers<unknown>()
    const authority = new AbortController()
    const request = vi.fn(() => clear.promise)
    const result = changeCodexThreadGoal(
      session(request),
      { kind: 'set', objective: 'Ship it' },
      true,
      undefined,
      authority.signal
    )
    const settled = vi.fn()
    void result.then(settled, settled)
    authority.abort(new Error('stopped'))
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    clear.resolve({ goal: null })
    await expect(result).rejects.toThrow('stopped')
    expect(request).toHaveBeenCalledOnce()
  })

  it('reports a cleared previous goal when replacement is refused', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cleared: true })
      .mockRejectedValueOnce(
        new CodexAppServerRequestError('thread/goal/set', -32600, 'goals disabled')
      )
    await expect(
      changeCodexThreadGoal(
        session(request),
        { kind: 'set', objective: 'Ship it' },
        true,
        undefined
      )
    ).resolves.toEqual({
      ok: false,
      rejected:
        'Codex cleared the previous goal but could not set the new goal. Set the goal again to continue.'
    })
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

describe('direct goal settings application', () => {
  async function fixture(timeout = 1_000) {
    const { fakeCodex, adapterFor, acquireReadyCodexForTest, identityFor } =
      await import('./codex-structured-session-adapter-fixture')
    const codex = fakeCodex()
    const adapter = adapterFor(codex, {}, [], { requestTimeoutMs: timeout })
    const acquisition = await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn'
    })
    const apply = (model = 'gpt-live', effort: string | null = 'medium') =>
      codex.connections[0].handlers.onNotification?.('thread/settings/updated', {
        threadId: 'thread-abc',
        threadSettings: { model, effort }
      })
    const goal = (model = 'gpt-live', effort?: string) =>
      adapter.changeThreadGoal({
        sessionId: 'session-1',
        fence: 7,
        change: { kind: 'status', status: 'active' },
        replacesGoal: false,
        executionOptions: { model, ...(effort ? { effort } : {}) }
      })
    const state = acquiredSettingsTestSeam(adapter)
    return { codex, adapter, apply, goal, settings: state.settings, state, acquisition }
  }

  it('keeps literal goal settings separate from exact applied turn proof and recovers on a successful turn', async () => {
    const { codex, adapter, apply, goal, acquisition } = await fixture()
    const choices = { model: 'unlisted-model-a', effort: 'high' }
    const dispatch = () =>
      adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: `message-${codex.connections[0].calls.length}`,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
        executionOptions: choices
      })
    const held = (options = choices) =>
      waitsForCodexTurnOptions(
        { provider: 'codex', sessionId: 'session-1' },
        {
          newestTurn: () => ({ turnId: 'goal-turn', state: 'running' }),
          itemBody: () => ({
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Continue' }]
          })
        },
        {
          clientMessageId: 'follow-up',
          fence: 7,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'pending',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null,
          options
        },
        { fence: 7, generation: acquisition.acquisitionGeneration, phase: 'ready' },
        adapter
      )
    const proof = () =>
      adapter.readAppliedInputOptions({
        sessionId: 'session-1',
        fence: 7,
        acquisitionGeneration: acquisition.acquisitionGeneration,
        next: choices
      })
    try {
      expect(await dispatch()).toMatchObject({ state: 'admitted' })
      expect(proof()?.active).toMatchObject(choices)
      codex.routes['thread/settings/update'] = (params) => {
        apply(String(params?.model), String(params?.effort))
        return {}
      }
      expect(await goal('unlisted-model-b', 'low')).toEqual({ ok: true })
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'thread/settings/update')
      ).toEqual([
        {
          method: 'thread/settings/update',
          params: { threadId: 'thread-abc', model: 'unlisted-model-b', effort: 'low' }
        }
      ])
      const appliedGoal = { model: 'unlisted-model-b', effort: 'low' }
      expect(proof()).toEqual({ active: appliedGoal, next: choices })
      apply('observation-only', 'medium')
      expect(proof()).toEqual({ active: appliedGoal, next: choices })
      codex.routes['thread/settings/update'] = () => {
        throw new CodexAppServerRequestError('thread/settings/update', -32602, 'invalid model')
      }
      expect(await goal('refused-model', 'high')).toMatchObject({ ok: false })
      expect(proof()).toEqual({ active: appliedGoal, next: choices })
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'thread/goal/set')
      ).toHaveLength(1)
      apply('observation-only-c', 'medium')
      const callsBeforeEquivalent = codex.connections[0].calls.filter(
        (call) => call.method === 'thread/settings/update'
      ).length
      expect(await goal('observation-only-c', 'medium')).toEqual({ ok: true })
      expect(proof()).toEqual({ active: appliedGoal, next: choices })
      expect(held(appliedGoal)).toBe(false)
      expect(held({ model: 'observation-only-c', effort: 'medium' })).toBe(true)
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'thread/settings/update')
      ).toHaveLength(callsBeforeEquivalent)
      codex.routes['thread/settings/update'] = () => {
        throw new Error('reply lost after settings enqueue')
      }
      expect(await goal('uncertain-model', 'low')).toMatchObject({ ok: false })
      expect(proof()).toEqual({ active: { effort: 'low' }, next: choices })
      expect(held()).toBe(true)
      expect(await dispatch()).toMatchObject({ state: 'admitted' })
      expect(proof()).toEqual({ active: choices, next: choices })
      codex.routes['thread/settings/update'] = () => {
        throw new CodexAppServerRequestError('thread/settings/update', -32601, 'method not found')
      }
      expect(await goal('unlisted-model-b', 'low')).toEqual({ ok: true })
      expect(proof()).toEqual({ active: choices, next: choices })
      const callsBeforeCached = codex.connections[0].calls.filter(
        (call) => call.method === 'thread/settings/update'
      ).length
      expect(await goal('unlisted-model-b', 'low')).toEqual({ ok: true })
      expect(proof()).toEqual({ active: choices, next: choices })
      expect(held()).toBe(false)
      expect(held(appliedGoal)).toBe(true)
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'thread/settings/update')
      ).toHaveLength(callsBeforeCached)
      expect(await dispatch()).toMatchObject({ state: 'admitted' })
      expect(proof()).toEqual({ active: choices, next: choices })
    } finally {
      await adapter.closeAll()
    }
  })

  it('retains authoritative A after a definitely rejected turn B, so a no-op Resume A needs no notification', async () => {
    const { codex, adapter, goal } = await fixture()
    codex.routes['turn/start'] = () => {
      throw new CodexAppServerRequestError('turn/start', -32602, 'invalid model')
    }
    expect(
      await adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'message',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Try B' }] },
        executionOptions: { model: 'model-b', effort: 'high' }
      })
    ).toMatchObject({ state: 'rejected' })
    expect(await goal()).toEqual({ ok: true })
    expect(codex.connections[0].calls.some((r) => r.method === 'thread/settings/update')).toBe(
      false
    )
    await adapter.closeAll()
  })

  it.each(['success', 'rejection', 'stale'] as const)(
    'rechecks current application after its RPC reply, preserving pre-reply evidence (%s)',
    async (mode) => {
      const { codex, adapter, apply, goal, state } = await fixture(10)
      vi.useFakeTimers()
      try {
        const answer = Promise.withResolvers<unknown>()
        codex.routes['thread/settings/update'] = () => {
          apply('model-b', 'high')
          return answer.promise
        }
        const pending = goal('model-b', 'high')
        await Promise.resolve()
        expect(codex.connections[0].calls.some((r) => r.method === 'thread/goal/set')).toBe(false)
        if (mode === 'rejection') {
          answer.reject(
            new CodexAppServerRequestError('thread/settings/update', -32602, 'invalid model')
          )
        } else {
          if (mode === 'stale') {
            apply('model-c', 'low')
          }
          answer.resolve({})
        }
        if (mode === 'stale') {
          await vi.advanceTimersByTimeAsync(10)
        }
        expect(await pending).toMatchObject({ ok: mode === 'success' })
        expect(codex.connections[0].calls.some((r) => r.method === 'thread/goal/set')).toBe(
          mode === 'success'
        )
        expect(state.listeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
        await adapter.closeAll()
      }
    }
  )

  it('retires an unknown turn prefix on uniquely applied C and retries C without another settings RPC', async () => {
    const { codex, adapter, apply, goal } = await fixture()
    codex.routes['turn/start'] = () => {
      throw new Error('reply lost after enqueue')
    }
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'unknown-turn',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'B' }] },
        executionOptions: { model: 'B', effort: 'high' }
      })
    ).rejects.toThrow('reply lost after enqueue')
    codex.routes['thread/settings/update'] = () => {
      apply('C', 'high')
      return {}
    }
    expect(await goal('C', 'high')).toMatchObject({ ok: true })
    expect(await goal('C', 'high')).toMatchObject({ ok: true })
    expect(
      codex.connections[0].calls.filter((r) => r.method === 'thread/settings/update')
    ).toHaveLength(1)
    await adapter.closeAll()
  })

  it.each([
    {
      name: 'stronger unique model after earlier effort match',
      writes: [
        { model: 'B', effort: 'high' },
        { model: 'D', effort: 'low' },
        { model: 'C', effort: 'high' }
      ],
      observed: ['C', 'high'],
      query: ['C', 'high'],
      ok: true,
      retained: 0
    },
    {
      name: 'reused/coalesced A/B/A stays ambiguous',
      writes: [
        { model: 'A', effort: 'high' },
        { model: 'B', effort: 'high' },
        { model: 'A', effort: 'high' }
      ],
      observed: ['A', 'high'],
      query: ['A', 'high'],
      ok: false,
      retained: 2
    },
    {
      name: 'model-only prefix proves earlier effort completed',
      writes: [{ effort: 'high' }, { model: 'C' }],
      observed: ['C', 'medium'],
      query: ['C', 'medium'],
      ok: true,
      retained: 0
    },
    {
      name: 'later effort writer remains unresolved',
      writes: [{ model: 'B', effort: 'high' }, { model: 'C' }, { effort: 'low' }],
      observed: ['C', 'medium'],
      query: ['C', 'medium'],
      ok: false,
      retained: 1
    },
    {
      name: 'omitted effort ignores later effort writer',
      writes: [{ model: 'B', effort: 'high' }, { model: 'C' }, { effort: 'low' }],
      observed: ['C', 'medium'],
      query: ['C'],
      ok: true,
      retained: 1
    }
  ])('$name', async ({ writes, observed, query, ok, retained }) => {
    const { adapter, apply, goal, settings, state } = await fixture(10)
    vi.useFakeTimers()
    try {
      apply('S', 'medium')
      for (const write of writes) {
        settings.attempt(write)
      }
      apply(observed[0], observed[1])
      expect(state.pending.size).toBe(retained)
      const result = goal(query[0], query[1])
      if (!ok) {
        await vi.advanceTimersByTimeAsync(10)
      }
      expect(await result).toMatchObject({ ok })
      expect(state.listeners.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await adapter.closeAll()
    }
  })

  it.each(
    [100, 1000].flatMap((n) =>
      ['identical', 'alternating', 'unique'].map((pattern) => ({ n, pattern }))
    )
  )(
    'bounds actual unresolved evidence/trigger work at $n $pattern controls and clears recovery/end',
    async ({ n, pattern }) => {
      const { codex, adapter, apply, settings, state } = await fixture(10)
      vi.useFakeTimers()
      try {
        apply('S', 'medium')
        const pending = state.pending
        let fields = 0,
          visits = 0
        const add = pending.add.bind(pending)
        vi.spyOn(pending, 'add').mockImplementation((write) => {
          if (typeof write !== 'object' || write === null) {
            throw new Error('invalid settings attempt')
          }
          const { model, effort } = readRecord(write)
          if (
            (model !== undefined && typeof model !== 'string') ||
            (effort !== undefined && effort !== null && typeof effort !== 'string')
          ) {
            throw new Error('invalid settings projection')
          }
          Object.defineProperties(write, {
            model: {
              get: () => {
                fields++
                return model
              }
            },
            effort: {
              get: () => {
                fields++
                return effort
              }
            }
          })
          return add(write)
        })
        const iterate = pending[Symbol.iterator].bind(pending)
        vi.spyOn(pending, Symbol.iterator).mockImplementation(() => {
          const iterator = iterate()
          const next = iterator.next.bind(iterator)
          vi.spyOn(iterator, 'next').mockImplementation(() => {
            const result = next()
            if (!result.done) {
              visits++
            }
            return result
          })
          return iterator
        })
        for (let i = 0; i < n; i++) {
          settings.attempt({
            get model() {
              fields++
              return pattern === 'unique' ? `M${i}` : 'S'
            },
            get effort() {
              fields++
              return pattern === 'unique'
                ? 'medium'
                : pattern === 'identical' || i % 2 === 0
                  ? 'high'
                  : 'low'
            }
          })
        }
        expect(pending.size).toBe(n)
        const buildFields = fields
        expect(fields).toBeLessThanOrEqual(8 * n)
        expect(visits).toBe(0) // Snapshot mismatches never enumerate/copy prior tokens.
        const q = { model: 'unique-final-C', effort: 'high' }
        const install = settings.install(codex.connections[0], 'thread-abc', q, 10)
        await Promise.resolve()
        expect(state.listeners.size).toBe(1)
        expect(vi.getTimerCount()).toBe(1)
        fields = 0
        visits = 0
        for (let i = 0; i < n; i++) {
          apply('S', 'medium')
        }
        expect({ fields, visits }).toEqual({ fields: 0, visits: 0 })
        apply(q.model, q.effort)
        expect(await install).toEqual({ ok: true })
        const application = { fields, visits }
        expect(fields).toBeLessThanOrEqual(8 * (n + 1))
        expect(visits).toBeLessThanOrEqual(2 * (n + 1))
        expect(pending.size).toBe(0)
        fields = 0
        visits = 0
        const calls = codex.connections[0].calls.length
        expect(await settings.install(codex.connections[0], 'thread-abc', q, 10)).toEqual({
          ok: true
        })
        expect(codex.connections[0].calls).toHaveLength(calls)
        expect({ fields, visits }).toEqual({ fields: 0, visits: 0 })
        expect(state.listeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        for (let i = 0; i < n; i++) {
          settings.attempt({ model: `unended-${i}` })
        }
        expect(pending.size).toBe(n)
        await adapter.closeSession('session-1')
        expect(pending.size).toBe(0)
        console.info('settings-perf', {
          n,
          pattern,
          buildFields,
          buildVisits: 0,
          noiseFields: 0,
          noiseVisits: 0,
          application,
          retainedUnknown: n,
          retainedAfterProof: 0,
          retainedAtEnd: pending.size
        })
        expect(state.snapshot).toEqual({})
        expect(state.listeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
        await adapter.closeAll()
      }
    }
  )

  it('keeps an earlier unknown token when a retry reuses the same choice object and is definitely rejected', async () => {
    const { codex, adapter, apply, settings, state } = await fixture(10)
    apply('S', 'medium')
    const choice = { model: 'B', effort: 'high' }
    settings.attempt(choice)
    codex.routes['thread/settings/update'] = () => {
      throw new CodexAppServerRequestError('thread/settings/update', -32602, 'refused')
    }
    expect(await settings.install(codex.connections[0], 'thread-abc', choice, 10)).toMatchObject({
      ok: false
    })
    expect(state.pending.size).toBe(1)
    await adapter.closeAll()
  })

  it('bounds an acknowledged but unapplied update, and cancels its waiter on connection end', async () => {
    const { codex, adapter, goal, apply, state } = await fixture(10)
    vi.useFakeTimers()
    try {
      const pending = goal('model-b', 'high')
      await vi.advanceTimersByTimeAsync(10)
      expect(await pending).toMatchObject({
        ok: false,
        rejected: expect.stringContaining('did not confirm')
      })
      expect(codex.connections[0].calls.some((r) => r.method === 'thread/goal/set')).toBe(false)
      expect(state.listeners.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      apply('model-b', null)
      // Null is known provider state; an omitted effort is no override.
      expect(await goal('model-b')).toEqual({ ok: true })
      const closing = goal('model-c', 'high')
      await adapter.closeSession('session-1')
      expect(await closing).toMatchObject({
        ok: false,
        rejected: expect.stringContaining('did not confirm')
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await adapter.closeAll()
    }
  })
})

it('stops a settings wait as a definite pre-goal rejection without leaving an active waiter', async () => {
  const { fakeCodex, adapterFor, acquireReadyCodexForTest, identityFor } =
    await import('./codex-structured-session-adapter-fixture')
  const codex = fakeCodex()
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn'
  })
  const state = acquiredSettingsTestSeam(adapter)
  vi.useFakeTimers()
  try {
    const signal = new AbortController()
    const result = adapter.changeThreadGoal({
      sessionId: 'session-1',
      fence: 7,
      change: { kind: 'set', objective: 'not sent' },
      replacesGoal: true,
      executionOptions: { model: 'new-model' },
      signal: signal.signal
    })
    signal.abort(new Error('stopped'))
    expect(await result).toMatchObject({
      ok: false,
      rejected: expect.stringContaining('This goal change was not sent.')
    })
    expect(state.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(state.pending.size).toBe(1)
    codex.connections[0].handlers.onNotification?.('thread/settings/updated', {
      threadId: 'thread-abc',
      threadSettings: { model: 'new-model', effort: null }
    })
    expect(codex.connections[0].calls.some((r) => r.method.startsWith('thread/goal/'))).toBe(false)
  } finally {
    vi.useRealTimers()
    await adapter.closeAll()
  }
})
