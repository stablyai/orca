import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  THREAD_ID,
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor,
  type Route
} from './codex-structured-session-adapter-fixture'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import type { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import { nativeSessionOptionsFromReport } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'

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
  return adapter.acquire({
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
  it('starts the chat and sends the saved tier when its own listing rejects', async () => {
    const codex = fakeCodex({
      'model/list': () => {
        throw new Error('model listing unavailable')
      }
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const adapter = adapterFor(codex)

    await acquire(adapter)
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toMatchObject({
      serviceTier: 'priority'
    })
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority' })
  })

  it('sends the saved tier while its own bounded listing is still pending', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'first-turn')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await acquire(adapter)
    await vi.waitFor(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(true)
    )
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority' })
    pending.resolve(listing())
  })

  it('steers an active turn while catalog discovery remains pending', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'running-turn')
    codex.routes['turn/steer'] = () => ({ turn: { id: 'running-turn' } })
    const adapter = adapterFor(codex)
    await acquire(adapter)
    await send(adapter, 'first')
    await send(adapter, 'follow-up')
    expect(codex.connections[0].calls.some((call) => call.method === 'turn/steer')).toBe(true)
    expect(codex.connections[0].calls.filter((call) => call.method === 'model/list')).toHaveLength(
      1
    )
    pending.resolve(listing())
  })

  it('stops a running turn and starts its replacement on the saved tier while listing stalls', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
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
    pending.resolve(listing())
  })

  it('records a background failure without delaying a send and retries after the failure TTL', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const modelCatalog = new AgentModelCatalogStore({ now: () => now })
    const listModels: Mock<Route> = vi
      .fn<Route>()
      .mockImplementationOnce(() => {
        throw new Error('catalog unavailable')
      })
      .mockImplementation(() => listing())
    const codex = fakeCodex({ 'model/list': listModels })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    try {
      await acquire(adapter)
      await vi.waitFor(() => expect(modelCatalog.hasActiveFailure(access.fingerprint)).toBe(true))
      await send(adapter, 'first')
      expect(
        codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
      ).toMatchObject({ serviceTier: 'priority' })
      await acquire(adapter, 'session-2')
      expect(listModels).toHaveBeenCalledOnce()
      now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
      await acquire(adapter, 'session-3')
      await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2))
    } finally {
      clock.mockRestore()
    }
  })

  it('does not record an obsolete child’s catalog over its replacement’s', async () => {
    const oldListing = Promise.withResolvers<unknown>()
    const newListing = Promise.withResolvers<unknown>()
    const codex = fakeCodex({
      'model/list': vi
        .fn<Route>()
        .mockImplementationOnce(() => oldListing.promise)
        .mockImplementationOnce(() => newListing.promise)
    })
    const modelCatalog = new AgentModelCatalogStore()
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    await acquire(adapter)
    await acquire(adapter)
    oldListing.resolve(listing('priority-old'))
    newListing.resolve(listing('priority-new'))
    await vi.waitFor(() =>
      expect(modelCatalog.get(access.fingerprint)?.models[0]?.serviceTiers?.[0]?.value).toBe(
        'priority-new'
      )
    )
  })

  it('restores the saved model and tier over the resumed thread’s', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const adapter = adapterFor(codex, { codexHome: '/codex/home', resumeThreadId: THREAD_ID })
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-resume',
      options: { model: 'gpt-next', serviceTier: 'ultrafast' }
    })

    expect(codex.connections[0].calls.some((call) => call.method === 'thread/resume')).toBe(true)
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toEqual({
      model: 'gpt-next',
      serviceTier: 'ultrafast'
    })
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'gpt-next', serviceTier: 'ultrafast' })
  })
})

describe('Codex service tier across clients and rest', () => {
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
        origin: 'probe'
      },
      'discovery'
    )
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-1' })

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
  })

  it('takes a tier at rest but not an older client Fast toggle', () => {
    expect(CODEX_STRUCTURED_AGENT.restingOptions?.acceptsKey('serviceTier')).toBe(true)
    expect(CODEX_STRUCTURED_AGENT.restingOptions?.acceptsKey('fastMode')).toBe(false)
  })

  it('keeps only the reported tier, not the Fast it implies, on the record', () => {
    expect(
      nativeSessionOptionsFromReport({
        reported: { model: 'gpt-live', serviceTier: 'priority', fastMode: true },
        restoreSkipped: [],
        priorOptions: { fastMode: 'true', serviceTier: 'ultrafast' }
      })
    ).toEqual({ model: 'gpt-live', serviceTier: 'priority' })
    // An agent that reports Fast with no tier still keeps it.
    expect(
      nativeSessionOptionsFromReport({ reported: { fastMode: true }, restoreSkipped: [] })
    ).toEqual({ fastMode: 'true' })
  })
})
