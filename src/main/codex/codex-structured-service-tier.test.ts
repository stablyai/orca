import { describe, expect, it } from 'vitest'
import {
  acquireReadyCodexForTest,
  codexStartReport,
  THREAD_ID,
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import type { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'

function listing(tier = 'priority') {
  return {
    data: [
      {
        model: 'gpt-live',
        supportedReasoningEfforts: [],
        serviceTiers: [{ id: tier, name: 'Fast' }]
      }
    ],
    nextCursor: null
  }
}

async function acquire(adapter: CodexStructuredSessionAdapter, sessionId = 'session-1') {
  return acquireReadyCodexForTest(adapter, {
    identity: identityFor(sessionId),
    fence: 7,
    spawnToken: `spawn-${sessionId}`,
    options: { serviceTier: 'priority' }
  })
}

async function send(adapter: CodexStructuredSessionAdapter, id: string, sessionId = 'session-1') {
  return adapter.dispatch({ sessionId, clientMessageId: id, body: USER_MESSAGE, fence: 7 })
}

function finishTurn(codex: ReturnType<typeof fakeCodex>, turnId: string) {
  codex.connections.at(-1)?.handlers.onNotification?.('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: turnId, status: 'completed' }
  })
}

describe('Codex structured service tier without send-path catalog waits', () => {
  it('starts the chat and sends the saved tier without asking its child for an inventory', async () => {
    const codex = fakeCodex({
      'model/list': () => {
        throw new Error('model listing unavailable')
      }
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const adapter = adapterFor(codex)

    await acquire(adapter)
    expect(codexStartReport(adapter).reportedOptions).toMatchObject({
      serviceTier: 'priority'
    })
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority' })
  })

  it('steers an active turn without querying the child inventory', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'running-turn')
    codex.routes['turn/steer'] = () => ({ turn: { id: 'running-turn' } })
    const adapter = adapterFor(codex)
    await acquire(adapter)
    await send(adapter, 'first')
    await send(adapter, 'follow-up')
    expect(codex.connections[0].calls.some((call) => call.method === 'turn/steer')).toBe(true)
    expect(codex.connections[0].calls.filter((call) => call.method === 'model/list')).toHaveLength(
      0
    )
  })

  it('stops a running turn and starts its replacement on the saved tier', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'running-turn')
    const adapter = adapterFor(codex)
    await acquire(adapter)
    await send(adapter, 'first')

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      cancelled: true
    })
    finishTurn(codex, 'running-turn')
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'replacement-turn')
    await send(adapter, 'replacement')
    const starts = codex.connections[0].calls.filter((call) => call.method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(starts[1]?.params).toMatchObject({ serviceTier: 'priority' })
  })

  it('restores the saved model and tier over the resumed thread’s', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const adapter = adapterFor(codex, { codexHome: '/codex/home', resumeThreadId: THREAD_ID })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-resume',
      options: { model: 'gpt-next', serviceTier: 'ultrafast' }
    })

    expect(codex.connections[0].calls.some((call) => call.method === 'thread/resume')).toBe(true)
    expect(codexStartReport(adapter).reportedOptions).toEqual({
      model: 'gpt-next',
      reportedPermissionMode: null,
      serviceTier: 'ultrafast'
    })
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'gpt-next', serviceTier: 'ultrafast' })
  })
})

describe('Codex service tier across clients and rest', () => {
  it.each([
    ['opening null', null, 'default'],
    ['configured tier', undefined, 'priority'],
    ['configuration failure', undefined, undefined]
  ] as const)(
    'seeds exact-child tier knowledge from %s without filling a sparse request',
    async (name, openingTier, expected) => {
      const codex = fakeCodex({
        'thread/start': () => ({
          thread: { id: THREAD_ID },
          model: 'gpt-live',
          reasoningEffort: 'high',
          ...(openingTier === null ? { serviceTier: null } : {})
        }),
        'config/read': () => {
          if (name === 'configuration failure') {
            throw new Error('config unavailable')
          }
          return {
            config: {
              service_tier: 'priority',
              model: 'unrelated-config-model',
              model_reasoning_effort: 'low'
            }
          }
        }
      })
      codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'sparse')
      const adapter = adapterFor(codex)
      try {
        const acquired = await acquireReadyCodexForTest(adapter, {
          identity: identityFor('session-1'),
          fence: 7,
          spawnToken: 'spawn-1'
        })
        const applied = adapter.readAppliedInputOptions({
          sessionId: 'session-1',
          fence: 7,
          acquisitionGeneration: acquired.acquisitionGeneration,
          next: {}
        })
        expect(applied?.active).toEqual({
          model: 'gpt-live',
          effort: 'high',
          ...(expected ? { serviceTier: expected } : {})
        })
        const config = codex.connections[0].calls.filter((call) => call.method === 'config/read')
        expect(config).toHaveLength(openingTier === null ? 0 : 1)
        if (config.length) {
          expect(config[0].params).toEqual({ cwd: '/work/repo' })
        }
        await adapter.dispatch({
          sessionId: 'session-1',
          fence: 7,
          clientMessageId: 'sparse',
          body: USER_MESSAGE,
          executionOptions: {}
        })
        const sent = codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
        expect(sent).not.toHaveProperty('model')
        expect(sent).not.toHaveProperty('effort')
        expect(sent).not.toHaveProperty('serviceTier')
      } finally {
        await adapter.closeAll()
      }
    }
  )

  it('applies an older client Fast toggle through the adapter as the Fast tier', async () => {
    const codex = fakeCodex({ 'model/list': () => listing() })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-fast')
    const modelCatalog = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    modelCatalog.recordSuccess(
      access.fingerprint,
      'codex',
      {
        models: [
          {
            id: 'gpt-live',
            label: 'GPT Live',
            isDefault: true,
            efforts: [],
            serviceTiers: [{ value: 'priority', label: 'Fast' }]
          }
        ],
        origin: 'probe',
        complete: true
      },
      'discovery'
    )
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1'
    })

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'fastMode', value: 'true', fence: 7 })
    ).resolves.toEqual({ serviceTier: 'priority' })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'approvalPolicy', value: 'never', fence: 7 })
    ).rejects.toThrow('no thread option named approvalPolicy')
    await send(adapter, 'first')
    const turn = codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    expect(turn).toMatchObject({ serviceTier: 'priority' })
    expect(turn).not.toHaveProperty('fastMode')
    finishTurn(codex, 'turn-fast')
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'captured-fast')
    await adapter.dispatch({
      sessionId: 'session-1',
      fence: 7,
      clientMessageId: 'captured-fast',
      body: USER_MESSAGE,
      executionOptions: { fastMode: 'true' }
    })
    const captured = codex.connections[0].calls.findLast(
      (call) => call.method === 'turn/start'
    )?.params
    expect(captured).toMatchObject({ serviceTier: 'priority' })
    expect(captured).not.toHaveProperty('model')
    expect(captured).not.toHaveProperty('effort')
  })

  it('takes a tier at rest but not an older client Fast toggle', () => {
    expect(CODEX_STRUCTURED_AGENT.restingOptions?.acceptsKey('serviceTier')).toBe(true)
    expect(CODEX_STRUCTURED_AGENT.restingOptions?.acceptsKey('fastMode')).toBe(false)
  })
})
