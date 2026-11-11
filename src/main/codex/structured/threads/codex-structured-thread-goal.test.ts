import { describe, expect, it, vi } from 'vitest'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { CodexAppliedSettings } from '../catalog/codex-structured-applied-settings'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { changeCodexThreadGoal } from './codex-structured-thread-goal'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import { waitsForCodexTurnOptions } from '../../../native-chat/agent-session-wire/options/structured-agent-session-message-options'

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
})

describe('direct goal settings application', () => {
  async function fixture(timeout = 1_000) {
    const { fakeCodex, adapterFor, acquireReadyCodexForTest, identityFor } =
      await import('../session-lifecycle/codex-structured-session-adapter-fixture')
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
    const turnProof = { model: 'unlisted-model-a', effort: 'high', interactionMode: 'default' }
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
      expect(proof()?.active).toEqual(turnProof)
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
      const appliedGoal = { model: 'unlisted-model-b', effort: 'low', interactionMode: 'default' }
      expect(proof()).toEqual({ active: appliedGoal, next: turnProof })
      apply('observation-only', 'medium')
      expect(proof()).toEqual({ active: appliedGoal, next: turnProof })
      codex.routes['thread/settings/update'] = () => {
        throw new CodexAppServerRequestError('thread/settings/update', -32602, 'invalid model')
      }
      expect(await goal('refused-model', 'high')).toMatchObject({ ok: false })
      expect(proof()).toEqual({ active: appliedGoal, next: turnProof })
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'thread/goal/set')
      ).toHaveLength(1)
      apply('observation-only-c', 'medium')
      const callsBeforeEquivalent = codex.connections[0].calls.filter(
        (call) => call.method === 'thread/settings/update'
      ).length
      expect(await goal('observation-only-c', 'medium')).toEqual({ ok: true })
      expect(proof()).toEqual({ active: appliedGoal, next: turnProof })
      expect(held(appliedGoal)).toBe(false)
      expect(held({ model: 'observation-only-c', effort: 'medium' })).toBe(true)
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'thread/settings/update')
      ).toHaveLength(callsBeforeEquivalent)
      codex.routes['thread/settings/update'] = () => {
        throw new Error('reply lost after settings enqueue')
      }
      expect(await goal('uncertain-model', 'low')).toMatchObject({ ok: false })
      expect(proof()).toEqual({
        active: { effort: 'low', interactionMode: 'default' },
        next: turnProof
      })
      expect(held()).toBe(true)
      expect(await dispatch()).toMatchObject({ state: 'admitted' })
      expect(proof()).toEqual({ active: turnProof, next: turnProof })
      codex.routes['thread/settings/update'] = () => {
        throw new CodexAppServerRequestError('thread/settings/update', -32601, 'method not found')
      }
      expect(await goal('unlisted-model-b', 'low')).toEqual({ ok: true })
      expect(proof()).toEqual({ active: turnProof, next: turnProof })
      const callsBeforeCached = codex.connections[0].calls.filter(
        (call) => call.method === 'thread/settings/update'
      ).length
      expect(await goal('unlisted-model-b', 'low')).toEqual({ ok: true })
      expect(proof()).toEqual({ active: turnProof, next: turnProof })
      expect(held()).toBe(false)
      expect(held(appliedGoal)).toBe(true)
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'thread/settings/update')
      ).toHaveLength(callsBeforeCached)
      expect(await dispatch()).toMatchObject({ state: 'admitted' })
      expect(proof()).toEqual({ active: turnProof, next: turnProof })
    } finally {
      await adapter.closeAll()
    }
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
    await import('../session-lifecycle/codex-structured-session-adapter-fixture')
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
