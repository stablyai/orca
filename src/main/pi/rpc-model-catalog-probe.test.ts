import { agentModelCatalogEntryWithSuccess } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { createPiModelCatalogProbe } from './rpc-model-catalog-probe'
import { readPiRpcSessionOptions, type PiRpcRequester } from './rpc-options'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { structuredAgentSessionMessageSelection } from '../../shared/structured-agent-session-option-view'
import { structuredAgentSessionSeedCatalog } from '../../shared/structured-agent-session-seed-catalog'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import * as probeRunner from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

const AVAILABLE_MODELS = {
  models: [
    {
      provider: 'openai',
      id: 'gpt-6',
      name: 'GPT-6',
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: 'xhigh' }
    },
    { provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: false }
  ]
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function catalog(request: PiRpcRequester['request'], now = Date.now) {
  const record = agentSessionRecordFixture({
    sessionId: 'pi-chat',
    provider: 'pi',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi' }
  })
  const close = vi.fn(async (): Promise<void> => undefined)
  const runListing = vi
    .spyOn(probeRunner, 'runAgentModelCatalogListing')
    .mockRejectedValue(new Error('unexpected text listing'))
  const probe = createPiModelCatalogProbe({
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    resolveCommand: () => '/opt/pi/bin/pi',
    probeVersion: async () => ({ version: '1.1.0' }),
    homePath: '/home/user',
    connect: () => ({ request, close })
  })
  const store = new AgentModelCatalogStore({ now })
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => agentSessionConversationView(record),
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => record.accountHome,
    probes: { pi: probe }
  })
  onTestFinished(() => service.stop())
  return {
    store,
    service,
    probe,
    record,
    close,
    runListing,
    fingerprint: agentModelCatalogFingerprintForRecord(record)
  }
}

describe('Pi model catalog', () => {
  it.each(['', `"${process.execPath}" run -- pi`])(
    'lists the native menu through sessionless RPC for Command %j',
    async (command) => {
      const launches: ProviderProcessLaunch[] = []
      const requests: string[] = []
      const close = vi.fn(async () => undefined)
      const probeVersion = vi.fn(async () => ({ version: '0.84.0' }))
      const probe = createPiModelCatalogProbe({
        resolveEnvironment: async () => ({
          PATH: '/usr/bin',
          HOME: '/home/user',
          ORCA_PANE_KEY: 'p'
        }),
        resolveCommandSettings: () => ({ agentCmdOverrides: { pi: command } }),
        resolveCommand: () => '/opt/pi/bin/pi',
        probeVersion,
        homePath: '/home/user',
        connect: (launch) => {
          launches.push(launch)
          return {
            request: async (command) => {
              requests.push(command)
              return command === 'get_state'
                ? { model: { provider: 'openai', id: 'gpt-6' }, thinkingLevel: 'xhigh' }
                : AVAILABLE_MODELS
            },
            close
          }
        }
      })
      const success = await probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' })
      expect(requests).toEqual(['get_state', 'get_available_models'])
      expect(success.configured).toEqual({ model: 'openai/gpt-6', effort: 'xhigh' })
      expect(
        agentModelCatalogEntryWithSuccess(
          undefined,
          { agent: 'pi', fingerprint: 'fp' },
          success,
          'discovery',
          1
        )?.models.find((row) => row.id === 'openai/gpt-6')?.declaredDefaultEffort
      ).toBe('xhigh')
      const levels = (values: string[]) => values.map((value) => ({ value, label: value }))
      expect(success.models).toEqual([
        {
          id: 'openai/gpt-6',
          label: 'GPT-6',
          isDefault: false,
          efforts: levels(['minimal', 'low', 'medium', 'high', 'xhigh'])
        },
        { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', isDefault: false, efforts: [] }
      ])
      const live = await readPiRpcSessionOptions({
        request: async (command) =>
          command === 'get_available_models'
            ? AVAILABLE_MODELS
            : { sessionFile: '/s.jsonl', isStreaming: false, isCompacting: false }
      })
      expect(success.models).toEqual(live.models)
      expect(launches).toEqual([
        expect.objectContaining({
          command: command ? process.execPath : '/opt/pi/bin/pi',
          cwd: '/home/user',
          args: [...(command ? ['run', '--', 'pi'] : []), '--mode', 'rpc', '--no-session'],
          env: expect.objectContaining({ PI_CODING_AGENT_DIR: '/homes/pi-a' }),
          // Orca's status extension stays silent in a probe that belongs to no pane.
          envToDelete: expect.arrayContaining(['ORCA_PANE_KEY'])
        })
      ])
      expect(probeVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          program: command ? process.execPath : '/opt/pi/bin/pi',
          prefixArgs: command ? ['run', '--', 'pi'] : []
        })
      )
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it.each(['error', 'timeout', 'early exit', 'empty'] as const)(
    'keeps the last good RPC menu on %s, records failure, and closes without a text listing',
    async (failure) => {
      const request = vi.fn<PiRpcRequester['request']>().mockResolvedValue(AVAILABLE_MODELS)
      const { store, service, probe, record, fingerprint, close, runListing } = catalog(request)
      await store.refresh(fingerprint, 'pi', () => probe(record.accountHome))
      const good = store.get(fingerprint)
      const detail = failure === 'empty' ? 'pi listed no models' : `pi RPC ${failure}`
      if (failure === 'timeout') {
        vi.useFakeTimers()
        request.mockImplementation(() => new Promise(() => {}))
      } else if (failure === 'empty') {
        request.mockResolvedValue({ models: [] })
      } else {
        request.mockRejectedValue(new Error(detail))
      }
      const refresh = store.refresh(fingerprint, 'pi', () => probe(record.accountHome))
      if (failure === 'timeout') {
        await vi.advanceTimersByTimeAsync(probeRunner.AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS)
      }
      expect(await refresh).toBeNull()
      expect(store.get(fingerprint)).toBe(good)
      expect(store.failureDetail(fingerprint)).toBe(
        failure === 'timeout' ? 'pi did not list models within 15000ms' : detail
      )
      expect(await service.prepareSaved({ agent: 'pi' })).toMatchObject({
        origin: 'probe',
        models: good!.models
      })
      expect(close).toHaveBeenCalledTimes(2)
      expect(runListing).not.toHaveBeenCalled()
    }
  )

  it('leaves a first failure unknown with an unpickable model, and lists after the failure TTL', async () => {
    let at = 1_000
    const request = vi.fn<PiRpcRequester['request']>().mockRejectedValue(new Error('RPC failed'))
    const { store, service, fingerprint, runListing } = catalog(request, () => at)
    await service.demand({ agent: 'pi' })
    const failed = await service.read({ agent: 'pi' })
    expect(failed).toEqual({ origin: 'unknown' })
    expect(store.failure(fingerprint)).toMatchObject({ detail: 'RPC failed' })
    expect(failed).not.toHaveProperty('unavailable')
    const seed = structuredAgentSessionSeedCatalog('pi')
    const state = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('pi', seed),
      seed,
      failed,
      { newLaunch: true }
    )
    expect(structuredAgentSessionOptionSnapshot(state)).toContainEqual(
      expect.objectContaining({
        id: 'model',
        label: 'Model',
        settable: false,
        disabledReason: 'available-after-session-start'
      })
    )
    expect(structuredAgentSessionMessageSelection(state)).toEqual({})
    await service.demand({ agent: 'pi' })
    expect(request).toHaveBeenCalledTimes(2)
    at += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    expect(store.hasActiveFailure(fingerprint)).toBe(false)
    request.mockResolvedValue(AVAILABLE_MODELS)
    await service.demand({ agent: 'pi' })
    expect(await service.read({ agent: 'pi' })).toMatchObject({
      origin: 'probe',
      models: [{ id: 'openai/gpt-6' }, { id: 'openai/gpt-4o-mini' }]
    })
    expect(store.failure(fingerprint)).toBeNull()
    expect(runListing).not.toHaveBeenCalled()
  })

  it.each(['during RPC', 'during teardown'] as const)(
    'records no failure when cancelled %s',
    async (when) => {
      const stop = new AbortController()
      const pending = Promise.withResolvers<unknown>()
      const started = Promise.withResolvers<void>()
      const request = async () => {
        started.resolve()
        if (when === 'during teardown') {
          throw new Error('RPC interrupted')
        }
        return pending.promise
      }
      const { store, probe, record, fingerprint, close, runListing } = catalog(request)
      if (when === 'during teardown') {
        close.mockImplementation(async () => stop.abort())
      }
      const refresh = store.refresh(
        fingerprint,
        'pi',
        () => probe(record.accountHome, { signal: stop.signal }),
        undefined,
        stop.signal
      )
      await started.promise
      if (when === 'during RPC') {
        stop.abort()
      }
      expect(await refresh).toBeNull()
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(store.failure(fingerprint)).toBeNull()
      expect(runListing).not.toHaveBeenCalled()
    }
  )

  it('keeps live chat menus local during failed discovery and preserves historical last-good data', async () => {
    const pending = Promise.withResolvers<unknown>()
    const started = Promise.withResolvers<void>()
    let attempts = 0
    const { store, service, probe, record, fingerprint, close, runListing } = catalog(
      async (command) => {
        if (command === 'get_state') {
          return {}
        }
        if (++attempts === 1) {
          throw new Error('first RPC failed')
        }
        started.resolve()
        return pending.promise
      }
    )
    await service.demand({ agent: 'pi' })
    expect(await service.read({ agent: 'pi' })).toEqual({ origin: 'unknown' })
    const discovery = store.refresh(fingerprint, 'pi', () => probe(record.accountHome))
    await started.promise
    const live = await readPiRpcSessionOptions({
      request: async (command) =>
        command === 'get_available_models'
          ? AVAILABLE_MODELS
          : { sessionFile: '/s.jsonl', isStreaming: false, isCompacting: false }
    })
    service.recordLiveListing(record.sessionId, { models: live.models })
    expect(live.models).toHaveLength(2)
    expect(store.get(fingerprint)).toBeNull()
    // Older persisted live data remains last-good until a discovery actually succeeds.
    const historical = store.recordSuccess(
      fingerprint,
      'pi',
      {
        models: [live.models[0]!],
        origin: 'live-session'
      },
      'live'
    )
    service.recordLiveListing(record.sessionId, { models: live.models })
    expect(store.get(fingerprint)).toBe(historical)
    pending.reject(new Error('RPC exited'))
    await discovery
    expect(store.failureDetail(fingerprint)).toBe('RPC exited')
    expect(await service.read({ agent: 'pi' })).toMatchObject({
      origin: 'live-session',
      models: historical!.models
    })
    expect(close).toHaveBeenCalledTimes(2)
    expect(runListing).not.toHaveBeenCalled()
  })

  it.each([
    [
      'positive',
      { model: { provider: 'openai', id: 'gpt-6' }, thinkingLevel: 'xhigh' },
      'openai/gpt-6',
      'xhigh'
    ],
    [
      'same model missing level',
      { model: { provider: 'openai', id: 'gpt-6' } },
      'openai/gpt-6',
      'high'
    ],
    [
      'invalid unrelated fields and level',
      { model: { provider: 'openai', id: 'gpt-6', reasoning: 'bad' }, thinkingLevel: 4 },
      'openai/gpt-6',
      'high'
    ],
    [
      'empty level',
      { model: { provider: 'openai', id: 'gpt-6' }, thinkingLevel: '' },
      'openai/gpt-6',
      'high'
    ],
    [
      'different model missing level',
      { model: { provider: 'openai', id: 'gpt-4o-mini' } },
      'openai/gpt-4o-mini',
      undefined
    ],
    [
      'unlisted identity',
      { model: { provider: 'custom', id: 'project-only' }, thinkingLevel: 'max' },
      'custom/project-only',
      'max'
    ],
    [
      'unsupported literal level',
      { model: { provider: 'openai', id: 'gpt-6' }, thinkingLevel: 'future-level' },
      'openai/gpt-6',
      'future-level'
    ],
    [
      'nonreasoning level',
      { model: { provider: 'openai', id: 'gpt-4o-mini' }, thinkingLevel: 'high' },
      'openai/gpt-4o-mini',
      'high'
    ],
    ['missing model', { thinkingLevel: 'low' }, undefined, undefined],
    ['null model', { model: null, thinkingLevel: 'low' }, undefined, undefined],
    ['empty identity', { model: { provider: '', id: 'gpt-6' } }, undefined, undefined],
    ['invalid provider', { model: { provider: 'open/ai', id: 'gpt-6' } }, undefined, undefined],
    ['malformed model', { model: 4 }, undefined, undefined],
    ['malformed payload', null, undefined, undefined],
    ['rejected state', new Error('state unavailable'), undefined, undefined]
  ] as const)(
    'learns only positive discovery defaults: %s',
    async (_name, state, model, effort) => {
      const request = vi.fn<PiRpcRequester['request']>(async (command) => {
        if (command === 'get_available_models') {
          return AVAILABLE_MODELS
        }
        if (state instanceof Error) {
          throw state
        }
        return state
      })
      const { store, probe, record, fingerprint, close } = catalog(request, () => 200)
      store.recordSuccess(
        fingerprint,
        'pi',
        {
          models: [{ id: 'openai/gpt-6', label: 'old', isDefault: false, efforts: [] }],
          configured: { model: 'openai/gpt-6', effort: 'high' },
          origin: 'probe'
        },
        'discovery'
      )
      const previous = store.get(fingerprint)!.configured
      const success = await store.refresh(fingerprint, 'pi', () => probe(record.accountHome))
      expect(success?.configured).toEqual(
        model ? { modelId: model, ...(effort ? { effort } : {}), at: 200 } : previous
      )
      if (!model) {
        expect(success?.configured).toBe(previous)
      }
      expect(success?.models.map((row) => row.id)).toEqual(['openai/gpt-6', 'openai/gpt-4o-mini'])
      expect(success?.models.filter((row) => row.isDefault).map((row) => row.id)).toEqual(
        model === 'custom/project-only' ? [] : [model ?? 'openai/gpt-6']
      )
      expect(success?.models[1]!.efforts).toEqual([])
      if (effort === 'future-level' || model === 'openai/gpt-4o-mini') {
        expect(success?.models.find((row) => row.id === model)).not.toHaveProperty('defaultEffort')
      }
      expect(request.mock.calls.map(([command]) => command)).toEqual([
        'get_state',
        'get_available_models'
      ])
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it.each(['abort', 'retirement'] as const)(
    'does not continue optional state acquisition after %s',
    async (ending) => {
      const stop = new AbortController()
      let current = true
      const request = vi.fn<PiRpcRequester['request']>(async () => {
        if (ending === 'abort') {
          stop.abort()
        }
        current = false
        throw new Error('state ended')
      })
      const { probe, record, close } = catalog(request)
      await expect(
        probe(record.accountHome, {
          signal: stop.signal,
          operation: { signal: stop.signal, current: () => current }
        })
      ).rejects.toThrow()
      expect(request.mock.calls.map(([command]) => command)).toEqual(['get_state'])
      expect(close).toHaveBeenCalledOnce()
    }
  )

  it('publishes no partial defaults when inventory is malformed', async () => {
    const { store, probe, record, fingerprint } = catalog(async (command) =>
      command === 'get_state'
        ? { model: { provider: 'custom', id: 'unlisted' }, thinkingLevel: 'high' }
        : { models: 'invalid' }
    )
    expect(await store.refresh(fingerprint, 'pi', () => probe(record.accountHome))).toBeNull()
    expect(store.get(fingerprint)).toBeNull()
    expect(store.failure(fingerprint)).not.toBeNull()
  })

  it('lists nothing from a Pi that runs no structured chat', async () => {
    const connect = vi.fn()
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCommand: () => '/opt/pi/bin/pi',
      probeVersion: async () => ({ version: '0.83.9' }),
      connect
    })
    await expect(probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' })).rejects.toThrow(
      /does not run structured chats/
    )
    expect(connect).not.toHaveBeenCalled()
  })
})
