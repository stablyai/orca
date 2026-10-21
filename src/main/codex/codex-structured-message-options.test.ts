import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { optionSession } from './codex-structured-option-session.test-fixture'
import { resolvedCodexMessageOptions } from './codex-structured-message-options'
import { dispatchCodexTurn, startCodexTurn } from './codex-structured-turn-start'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import {
  acquireReadyCodexForTest,
  USER_MESSAGE,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

function seedMessageDefaults(session: CodexSession): void {
  const store = new AgentModelCatalogStore()
  const fingerprint = 'codex-message-defaults'
  store.recordSuccess(
    fingerprint,
    'codex',
    {
      origin: 'probe',
      models: [
        {
          id: 'model-a',
          label: 'Model A',
          isDefault: false,
          defaultEffort: 'low',
          serviceTiers: [{ value: 'priority', label: 'Priority' }],
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'model-b',
          label: 'Model B',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    },
    'discovery'
  )
  session.catalogAccess = { store, fingerprint, accountHomePath: '/test-account' }
}

describe('Codex captured message choices', () => {
  it('uses each message’s choices on turn/start and tracks the native attempted choice', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'turn-1' }
    }))
    const session = optionSession(request)
    session.options.set('model', 'saved-next')
    session.options.set('effort', 'medium')
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    for (const [id, model, effort] of [
      ['first', 'model-a', 'high'],
      ['second', 'model-b', 'low']
    ]) {
      const turnOptions = await resolvedCodexMessageOptions(session, { model, effort })
      await startCodexTurn(session, { clientMessageId: id, body, turnOptions })
    }
    session.activeTurnIds = new Set(['turn-1'])
    await startCodexTurn(session, {
      clientMessageId: 'steer',
      body,
      turnOptions: { personality: 'friendly', serviceTier: 'priority' }
    })
    expect(request.mock.calls.at(-1)?.[0]).toBe('turn/steer')
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty('personality')
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty('serviceTier')
    expect(session.appliedTurnOptions).toEqual({ model: 'model-b', effort: 'low' })
    session.activeTurnIds = new Set()
    await startCodexTurn(session, {
      clientMessageId: 'next',
      body,
      turnOptions: { personality: 'friendly', serviceTier: 'priority' }
    })
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      personality: 'friendly',
      serviceTier: 'priority'
    })
    expect(
      request.mock.calls
        .filter(([method]) => method === 'turn/start')
        .map(([, params]) => [params?.model, params?.effort])
    ).toEqual([
      ['model-a', 'high'],
      ['model-b', 'low'],
      [undefined, undefined]
    ])
    expect(Object.fromEntries(session.options)).toEqual({
      personality: 'friendly',
      serviceTier: 'priority'
    })
  })

  it('resets an explicit empty choice after a thread launch and earlier turn override', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      method === 'turn/start'
        ? { turn: { id: 'opened' } }
        : { config: { personality: 'pragmatic', service_tier: 'flex' } }
    )
    const session = optionSession(request)
    session.reportedOptions = {
      model: 'model-a',
      effort: 'high',
      serviceTier: 'flex',
      serviceTierKnown: true
    }
    session.options = new Map([
      ['model', 'model-a'],
      ['effort', 'high'],
      ['personality', 'friendly'],
      ['serviceTier', 'priority']
    ])
    seedMessageDefaults(session)
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }

    for (const [id, choices] of [
      [
        'first',
        { model: 'model-a', effort: 'high', personality: 'friendly', serviceTier: 'priority' }
      ],
      ['second', {}],
      ['third', { model: 'model-a' }],
      ['fourth', { effort: 'low' }]
    ] as const) {
      const turnOptions = await resolvedCodexMessageOptions(session, choices)
      await startCodexTurn(session, { clientMessageId: id, body, turnOptions })
    }

    expect(
      request.mock.calls.filter(([method]) => method === 'turn/start').map(([, params]) => params)
    ).toMatchObject([
      { model: 'model-a', effort: 'high', personality: 'friendly', serviceTier: 'priority' },
      // Unchosen keys keep the thread's own model and effort, not the listing's defaults.
      { model: 'model-a', effort: 'high', personality: 'pragmatic', serviceTier: 'flex' },
      { model: 'model-a', effort: 'high' },
      { model: 'model-a', effort: 'low' }
    ])
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'config/read',
      'turn/start',
      'turn/start',
      'turn/start',
      'turn/start'
    ])
    expect(Object.fromEntries(session.options)).toEqual({
      model: 'model-a',
      effort: 'low'
    })
  })

  it('reports what a turn ran: a listed effort for an unlisted thread one, a steer its turn', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      method === 'turn/steer' ? { turnId: 'turn-1' } : { turn: { id: 'turn-1' } }
    )
    const session = optionSession(request)
    session.reportedOptions = { model: 'model-a', effort: 'xhigh' }
    seedMessageDefaults(session)
    const send = async (id: string, choices: Record<string, string>) =>
      dispatchCodexTurn(
        session,
        {
          sessionId: 'session-1',
          clientMessageId: id,
          body: USER_MESSAGE,
          turnOptions: await resolvedCodexMessageOptions(session, choices)
        },
        undefined
      )
    const ran = { model: 'model-a', effort: 'low' }
    expect(await send('first', { model: 'model-a' })).toMatchObject({ ranOptions: ran })
    expect(request.mock.calls[0]?.[1]).toMatchObject(ran)
    session.activeTurnIds = new Set(['turn-1'])
    const steered = await send('steer', { model: 'model-a', serviceTier: 'priority' })
    expect(request.mock.calls.at(-1)?.[0]).toBe('turn/steer')
    expect(steered).toMatchObject({ ranOptions: ran })
    expect(steered).not.toHaveProperty('ranOptions.serviceTier')
  })

  it('inherits untouched native tier and personality without a configuration probe', async () => {
    const request = vi.fn(async (_method: string) => ({ turn: { id: 'native' } }))
    const session = optionSession(request)
    session.reportedOptions = { model: 'model-a', serviceTier: 'flex', serviceTierKnown: true }
    const turnOptions = await resolvedCodexMessageOptions(session, {})
    await startCodexTurn(session, { clientMessageId: 'native', body: USER_MESSAGE, turnOptions })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0]).toBe('turn/start')
    expect(turnOptions).toEqual({})
  })

  it('opens from the first captured model even when launch resolution saw a newer saved pick', async () => {
    const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'opened' } }) })
    const adapter = adapterFor(codex, { model: 'model-b' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'model-a', effort: 'high' }
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'first',
      body: USER_MESSAGE,
      executionOptions: { model: 'model-a', effort: 'high' },
      fence: 7
    })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'thread/start')?.params
    ).toMatchObject({ model: 'model-a' })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'model-a', effort: 'high' })
  })

  it('preserves the old host path when no message snapshot was supplied', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'legacy' }
    }))
    const session = optionSession(request)
    session.options.set('model', 'saved-next')
    session.options.set('effort', 'high')
    const turnOptions = await resolvedCodexMessageOptions(session, undefined)
    await startCodexTurn(session, {
      clientMessageId: 'legacy',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      turnOptions
    })
    expect(request.mock.calls[0]?.[1]).toMatchObject({ model: 'saved-next', effort: 'high' })
  })

  it('refuses a default reset with no trustworthy default before prompt input', async () => {
    const request = vi.fn(async () => ({ turn: { id: 'unexpected' } }))
    const session = optionSession(request)
    session.reportedOptions = {}
    session.options.set('model', 'old-override')
    session.options.set('effort', 'high')
    await expect(resolvedCodexMessageOptions(session, {})).rejects.toThrow(
      'default model is unavailable'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('restores native options after a known refusal and retains them after an unknown answer', async () => {
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    const known = optionSession(
      vi.fn(async () => {
        throw new CodexAppServerRequestError('turn/start', -32602, 'invalid model')
      })
    )
    known.options.set('model', 'prior')
    await expect(
      startCodexTurn(known, { clientMessageId: 'known', body, turnOptions: { model: 'attempted' } })
    ).rejects.toThrow('invalid model')
    expect(Object.fromEntries(known.options)).toEqual({ model: 'prior' })
    const unknown = optionSession(
      vi.fn(async () => {
        throw new Error('connection lost after write')
      })
    )
    unknown.options.set('model', 'prior')
    await expect(
      startCodexTurn(unknown, {
        clientMessageId: 'unknown',
        body,
        turnOptions: { model: 'attempted' }
      })
    ).rejects.toThrow('connection lost after write')
    expect(Object.fromEntries(unknown.options)).toEqual({ model: 'attempted' })
  })
})
