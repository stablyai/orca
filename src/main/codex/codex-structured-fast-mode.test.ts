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

function listing(tier = 'priority-live-v2') {
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
    options: { fastMode: 'true' }
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

describe('Codex structured Fast mode without send-path catalog waits', () => {
  it('starts the chat and sends Standard when its own listing rejects', async () => {
    const codex = fakeCodex({
      'model/list': () => {
        throw new Error('model listing unavailable')
      }
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-standard')
    const adapter = adapterFor(codex)

    await acquire(adapter)
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toMatchObject({
      fastMode: 'true'
    })
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'default' })
  })

  it('uses a stored exact tier immediately on the first turn', async () => {
    const codex = fakeCodex()
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
        models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
        fastModeTierByModel: new Map([['gpt-live', 'priority-live-v2']]),
        origin: 'live-session'
      },
      'discovery'
    )
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    await acquire(adapter)
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority-live-v2' })
    expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(false)
  })

  it('sends Standard while its own bounded listing is pending, then uses Fast on a later turn', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'first-turn')
    const modelCatalog = new AgentModelCatalogStore()
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    await acquire(adapter)
    await vi.waitFor(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(true)
    )
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'default' })
    finishTurn(codex, 'first-turn')
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'second-turn')
    pending.resolve(listing())
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    await vi.waitFor(() =>
      expect(modelCatalog.get(access.fingerprint)?.fastModeTierByModel['gpt-live']).toBe(
        'priority-live-v2'
      )
    )
    await send(adapter, 'second')
    expect(
      codex.connections[0].calls.filter((call) => call.method === 'turn/start')[1]?.params
    ).toMatchObject({ serviceTier: 'priority-live-v2' })
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

  it('stops a running turn and starts its replacement as Standard while listing stalls', async () => {
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
    expect(codex.connections[0].calls.filter((call) => call.method === 'turn/start')).toHaveLength(
      2
    )
    expect(
      codex.connections[0].calls.filter((call) => call.method === 'turn/start')[1]?.params
    ).toMatchObject({ serviceTier: 'default' })
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
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-standard')
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
      ).toMatchObject({ serviceTier: 'default' })
      await acquire(adapter, 'session-2')
      expect(listModels).toHaveBeenCalledOnce()
      now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
      await acquire(adapter, 'session-3')
      await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2))
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps a newer picker success when its own older request later fails', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({
      'model/list': vi
        .fn<Route>()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementation(() => listing('priority-picker'))
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-fast')
    const modelCatalog = new AgentModelCatalogStore()
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    await acquire(adapter)
    await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'gpt-live', fence: 7 })
    ).resolves.toMatchObject({ model: 'gpt-live' })
    expect(codex.connections[0].calls.filter((call) => call.method === 'model/list')).toHaveLength(
      2
    )
    pending.reject(new Error('old request failed'))
    await vi.waitFor(() => expect(modelCatalog.failureDetail(access.fingerprint)).toBeNull())
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority-picker' })
  })

  it('does not apply an obsolete child’s catalog result to its replacement', async () => {
    const oldListing = Promise.withResolvers<unknown>()
    const newListing = Promise.withResolvers<unknown>()
    const codex = fakeCodex({
      'model/list': vi
        .fn<Route>()
        .mockImplementationOnce(() => oldListing.promise)
        .mockImplementationOnce(() => newListing.promise)
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-fast')
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
      expect(modelCatalog.get(access.fingerprint)?.fastModeTierByModel['gpt-live']).toBe(
        'priority-new'
      )
    )
    await send(adapter, 'first')
    expect(
      codex.connections.at(-1)?.calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority-new' })
  })

  it('lists on its own connection while a separate store probe is still pending', async () => {
    const probe = Promise.withResolvers<{
      models: [{ id: string; label: string; isDefault: boolean; efforts: [] }]
      fastModeTierByModel: Map<string, string>
      origin: 'probe'
    }>()
    const modelCatalog = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    const pendingProbe = () => probe.promise
    const probing = modelCatalog.refresh(access.fingerprint, 'codex', pendingProbe, pendingProbe)
    const codex = fakeCodex({ 'model/list': () => listing('priority-own') })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-fast')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })

    await acquire(adapter)
    await vi.waitFor(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(true)
    )
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority-own' })
    probe.resolve({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      fastModeTierByModel: new Map([['gpt-live', 'priority-probe']]),
      origin: 'probe'
    })
    await probing
  })

  it('migrates a legacy saved tier after its own listing arrives', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'first-turn')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-legacy',
      options: { serviceTier: 'priority-live-v2' }
    })
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'default' })
    finishTurn(codex, 'first-turn')
    pending.resolve(listing())
    await vi.waitFor(() =>
      expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toMatchObject({
        fastMode: 'true'
      })
    )
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'second-turn')
    await send(adapter, 'second')
    expect(
      codex.connections[0].calls.filter((call) => call.method === 'turn/start')[1]?.params
    ).toMatchObject({ serviceTier: 'priority-live-v2' })
  })

  it('sends a tier another writer stored even when its own listing fails', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-fast')
    const modelCatalog = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    await acquire(adapter)
    await vi.waitFor(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(true)
    )
    modelCatalog.recordSuccess(
      access.fingerprint,
      'codex',
      {
        models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
        fastModeTierByModel: new Map([['gpt-live', 'priority-probe']]),
        origin: 'probe'
      },
      'discovery'
    )
    pending.reject(new Error('own listing failed'))
    await vi.waitFor(() =>
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'model/list')
      ).toHaveLength(1)
    )
    await send(adapter, 'first')
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority-probe' })
  })

  it('restores saved Fast against the saved model, not the resumed thread model', async () => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-fast')
    const modelCatalog = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    const medium = [{ value: 'medium', label: 'Medium' }]
    modelCatalog.recordSuccess(
      access.fingerprint,
      'codex',
      {
        models: [
          {
            id: 'gpt-live',
            label: 'Live',
            isDefault: true,
            efforts: medium,
            supportsFastMode: false
          },
          {
            id: 'gpt-next',
            label: 'Next',
            isDefault: false,
            efforts: medium,
            supportsFastMode: true
          }
        ],
        fastModeTierByModel: new Map([['gpt-next', 'priority-next']]),
        origin: 'live-session'
      },
      'discovery'
    )
    const adapter = adapterFor(codex, { codexHome: '/codex/home', resumeThreadId: THREAD_ID }, [], {
      modelCatalog
    })
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-resume',
      options: { model: 'gpt-next', fastMode: 'true' }
    })

    expect(codex.connections[0].calls.some((call) => call.method === 'thread/resume')).toBe(true)
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toEqual({
      model: 'gpt-next',
      fastMode: 'true'
    })
    await send(adapter, 'first')
    const turn = codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    expect(turn).toMatchObject({ model: 'gpt-next', serviceTier: 'priority-next' })
    expect(turn).not.toHaveProperty('effort')
  })
})
