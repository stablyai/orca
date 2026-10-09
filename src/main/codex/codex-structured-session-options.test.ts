import {
  acquireReadyCodexForTest,
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  applyCodexStructuredSessionOption,
  readCodexStructuredSessionOptions,
  readLiveCodexSessionOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import { reportedCodexThreadOptions } from './codex-structured-fast-mode'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSession } from './codex-structured-session-state'
import { startCodexTurn } from './codex-structured-turn-start'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

function optionSession(request: CodexAppServerConnection['request']): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null
  }
}

async function primePicker(session: CodexSession): Promise<void> {
  session.catalogAccess = {
    store: new AgentModelCatalogStore(),
    fingerprint: 'codex-test-account',
    accountHomePath: '/test-account'
  }
  await readLiveCodexSessionOptions(session, undefined)
}

describe('structured Codex session options', () => {
  it.each([
    ['model', 'gpt-next'],
    ['effort', 'high'],
    ['fastMode', 'true']
  ])('keeps a cold %s pick as intent without starting a model request', async (key, value) => {
    const request = vi.fn(async () => ({ data: [] }))
    const session = optionSession(request)
    session.options.set('serviceTier', 'priority-old')

    await expect(applyCodexStructuredSessionOption(session, key, value)).resolves.toMatchObject({
      [key]: value
    })
    expect(session.options.has('serviceTier')).toBe(key !== 'fastMode')
    expect(request).not.toHaveBeenCalled()
  })

  it('drops an effort saved under another model on a cold model change', async () => {
    const session = optionSession(vi.fn(async () => ({ data: [] })))
    session.options.set('model', 'gpt-live')
    session.options.set('effort', 'xhigh')

    await expect(applyCodexStructuredSessionOption(session, 'model', 'gpt-live')).resolves.toEqual({
      model: 'gpt-live',
      effort: 'xhigh'
    })
    await expect(applyCodexStructuredSessionOption(session, 'model', 'gpt-next')).resolves.toEqual({
      model: 'gpt-next'
    })
  })

  it('turns Fast off immediately even without a catalog', async () => {
    const request = vi.fn(async () => ({ data: [] }))
    const session = optionSession(request)
    session.options.set('serviceTier', 'priority-old')

    await expect(applyCodexStructuredSessionOption(session, 'fastMode', 'false')).resolves.toEqual({
      fastMode: 'false'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('filters restored records to recognized turn options', () => {
    expect(
      Object.fromEntries(
        restoredCodexSessionOptions({
          model: 'gpt-live',
          effort: 'high',
          approvalPolicy: 'never',
          threadId: 'thread-injected',
          input: 'input-injected'
        })
      )
    ).toEqual({ model: 'gpt-live', effort: 'high' })
    expect(Object.fromEntries(restoredCodexSessionOptions({ serviceTier: 'default' }))).toEqual({
      fastMode: 'false'
    })
  })

  it('hydrates paged provider models and their supported efforts', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
      params?.cursor
        ? {
            data: [
              {
                model: 'gpt-second',
                displayName: 'GPT Second',
                description: 'Fast',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Quick reasoning' }
                ],
                defaultReasoningEffort: 'low',
                isDefault: false
              }
            ],
            nextCursor: null
          }
        : {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: 'page-2'
          }
    )

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'gpt-live', effort: 'medium' }
      })
    ).resolves.toEqual({
      models: [
        {
          id: 'gpt-live',
          label: 'GPT Live',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium', description: 'Balanced' },
            { value: 'high', label: 'High', description: 'Deep reasoning' }
          ]
        },
        {
          id: 'gpt-second',
          label: 'GPT Second',
          description: 'Fast',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [{ value: 'low', label: 'Low', description: 'Quick reasoning' }]
        }
      ],
      current: { model: 'gpt-live', effort: 'medium' }
    })
    expect(request).toHaveBeenNthCalledWith(
      2,
      'model/list',
      { limit: 100, includeHidden: false, cursor: 'page-2' },
      { timeoutMs: undefined }
    )
  })

  it('hydrates current values from thread start or resume', () => {
    expect(
      reportedCodexThreadOptions({
        threadId: 'thread-1',
        model: 'gpt-live',
        effort: 'high'
      })
    ).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('reconciles an incompatible effort when only the model changes', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          },
          {
            model: 'gpt-fast',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            defaultReasoningEffort: 'low'
          }
        ],
        nextCursor: null
      }))
    )

    await primePicker(session)
    await expect(applyCodexStructuredSessionOption(session, 'model', 'gpt-fast')).resolves.toEqual({
      model: 'gpt-fast',
      effort: 'low'
    })
  })

  it('rejects values absent from the provider catalog', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }],
        nextCursor: null
      }))
    )

    await primePicker(session)
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'not-entitled')
    ).rejects.toThrow('does not offer model not-entitled')
    await expect(applyCodexStructuredSessionOption(session, 'effort', 'high')).rejects.toThrow(
      'does not support high'
    )
  })

  it('maps canonical Fast on and off to the exact advertised tier and Standard', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params })
      return method === 'model/list'
        ? {
            data: [
              {
                model: 'gpt-live',
                supportedReasoningEfforts: [],
                serviceTiers: [
                  { id: 'rush-v7', name: 'Fast', description: 'Provider-routed Fast tier' }
                ]
              }
            ],
            nextCursor: null
          }
        : { turn: { id: `turn-${requests.length}` } }
    })
    const session = optionSession(request)
    await primePicker(session)

    await expect(
      applyCodexStructuredSessionOption(session, 'fastMode', 'true')
    ).resolves.toMatchObject({ fastMode: 'true' })
    await startCodexTurn(session, {
      clientMessageId: 'message-on',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'on' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'rush-v7'
    })

    await applyCodexStructuredSessionOption(session, 'fastMode', 'false')
    await startCodexTurn(session, {
      clientMessageId: 'message-off',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'off' }] }
    })
    expect(requests.filter((entry) => entry.method === 'turn/start')[1]?.params).toMatchObject({
      serviceTier: 'default'
    })
  })

  it('reports the current Fast value only when the opened thread tier matches the catalog', async () => {
    const connection = {
      request: vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [],
            serviceTiers: [{ id: 'priority-current', name: 'Fast' }]
          }
        ],
        nextCursor: null
      }))
    }

    await expect(
      readCodexStructuredSessionOptions({
        connection,
        current: { model: 'gpt-live' },
        reportedServiceTier: 'priority-current',
        reportedServiceTierKnown: true
      })
    ).resolves.toMatchObject({ current: { fastMode: true, confirmed: ['fastMode'] } })
    const unknown = await readCodexStructuredSessionOptions({
      connection,
      current: { model: 'gpt-live' },
      reportedServiceTier: 'unrecognized-tier',
      reportedServiceTierKnown: true
    })
    expect(unknown.current).toEqual({ model: 'gpt-live' })
  })

  it('hides and rejects Fast mode when the running catalog does not advertise it', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [],
            serviceTiers: []
          }
        ],
        nextCursor: null
      }))
    )

    await primePicker(session)
    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      models: [expect.objectContaining({ supportsFastMode: false })],
      fastModeSupport: { supported: false }
    })
    await expect(applyCodexStructuredSessionOption(session, 'fastMode', 'true')).rejects.toThrow(
      'does not support Fast mode'
    )
  })

  it('reconciles restored Fast on to explicit Standard when the selected model lost support', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    const session = optionSession(
      vi.fn(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params })
        return method === 'model/list'
          ? {
              data: [
                {
                  model: 'gpt-live',
                  supportedReasoningEfforts: [],
                  serviceTiers: []
                }
              ],
              nextCursor: null
            }
          : { turn: { id: 'turn-standard' } }
      })
    )
    session.options.set('fastMode', 'true')

    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { fastMode: false }
    })
    expect(Object.fromEntries(session.options)).toEqual({ fastMode: 'false' })

    await startCodexTurn(session, {
      clientMessageId: 'message-standard',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'standard' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'default'
    })
  })

  it('uses Standard until a missing Fast catalog recovers without losing restored intent', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    let catalogRecovered = false
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === 'turn/start') {
        return { turn: { id: `turn-${requests.length}` } }
      }
      return {
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [],
            ...(catalogRecovered
              ? { serviceTiers: [{ id: 'priority-recovered', name: 'Fast' }] }
              : {})
          }
        ],
        nextCursor: null
      }
    })
    const session = optionSession(request)
    let now = 1_000
    const store = new AgentModelCatalogStore({ now: () => now })
    session.catalogAccess = { store, fingerprint: 'codex-test-account', accountHomePath: '/test' }
    session.options.set('fastMode', 'true')

    const unknown = await readLiveCodexSessionOptions(session, undefined)
    expect(unknown).toMatchObject({
      current: { fastMode: true }
    })
    expect(unknown.fastModeSupport).toBeUndefined()
    expect(unknown.models[0]?.supportsFastMode).toBeUndefined()
    expect(session.options.get('fastMode')).toBe('true')
    await startCodexTurn(session, {
      clientMessageId: 'message-unverified',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'unverified' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'default'
    })
    expect(session.options.get('fastMode')).toBe('true')

    catalogRecovered = true
    now += AGENT_MODEL_CATALOG_FRESH_MS
    // Served from the aged entry; the refresh behind it names the tier.
    await readLiveCodexSessionOptions(session, undefined)
    await vi.waitFor(() =>
      expect(store.get('codex-test-account')?.fastModeTierByModel['gpt-live']).toBe(
        'priority-recovered'
      )
    )
    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      models: [expect.objectContaining({ supportsFastMode: true })],
      fastModeSupport: { supported: true },
      current: { fastMode: true }
    })
    await startCodexTurn(session, {
      clientMessageId: 'message-recovered',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'recovered' }] }
    })
    expect(requests.filter((entry) => entry.method === 'turn/start')[1]?.params).toMatchObject({
      serviceTier: 'priority-recovered'
    })
  })

  it('allows explicit Fast off without positive model support', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    const session = optionSession(
      vi.fn(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params })
        return method === 'model/list'
          ? {
              data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }],
              nextCursor: null
            }
          : { turn: { id: 'turn-standard' } }
      })
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'fastMode', 'false')
    ).resolves.toMatchObject({ fastMode: 'false' })
    await startCodexTurn(session, {
      clientMessageId: 'message-standard',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'standard' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'default'
    })
  })

  it('uses only the bounded legacy Fast tier value the provider advertised', async () => {
    const result = await readCodexStructuredSessionOptions({
      connection: {
        request: vi.fn(async () => ({
          data: [
            {
              model: 'gpt-live',
              supportedReasoningEfforts: [],
              additionalSpeedTiers: ['fast']
            }
          ],
          nextCursor: null
        }))
      },
      current: { model: 'gpt-live' }
    })
    expect(result.models[0]).toMatchObject({ supportsFastMode: true })
    expect(result.fastModeSupport).toEqual({ supported: true })
  })

  it('normalizes a legacy durable tier while preserving a canonical explicit choice', async () => {
    const request = vi.fn(async () => ({
      data: [
        {
          model: 'gpt-live',
          supportedReasoningEfforts: [],
          serviceTiers: [{ id: 'priority-migrated', name: 'Fast' }]
        }
      ],
      nextCursor: null
    }))
    const migrated = optionSession(request)
    migrated.options.set('serviceTier', 'priority-migrated')

    await expect(readLiveCodexSessionOptions(migrated, undefined)).resolves.toMatchObject({
      current: { fastMode: true }
    })
    expect(Object.fromEntries(migrated.options)).toEqual({ fastMode: 'true' })

    const canonical = optionSession(request)
    canonical.options.set('fastMode', 'false')
    canonical.options.set('serviceTier', 'priority-migrated')
    await readLiveCodexSessionOptions(canonical, undefined)
    expect(Object.fromEntries(canonical.options)).toEqual({ fastMode: 'false' })
  })

  it('reconciles Fast off when switching to an unsupported model', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [],
            serviceTiers: [{ id: 'priority-x', name: 'Fast', description: 'Fast' }]
          },
          { model: 'gpt-standard', supportedReasoningEfforts: [], serviceTiers: [] }
        ],
        nextCursor: null
      }))
    )
    session.options.set('fastMode', 'true')
    await primePicker(session)

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-standard')
    ).resolves.toMatchObject({ model: 'gpt-standard', fastMode: 'false' })
  })
})

describe('Codex service tier is not a settable option', () => {
  /** The turn derives the tier from `fastMode`, so accepting a direct write would
   *  report success for a value the next turn discards. Restore still reads the key
   *  so a session persisted before Fast existed migrates. */
  it('refuses a direct serviceTier write while still restoring a legacy one', async () => {
    const session = optionSession(async () => ({ data: [] }))

    await expect(
      applyCodexStructuredSessionOption(session, 'serviceTier', 'priority')
    ).rejects.toThrow('cannot be set directly')
    expect(session.options.has('serviceTier')).toBe(false)

    expect(Object.fromEntries(restoredCodexSessionOptions({ serviceTier: 'default' }))).toEqual({
      fastMode: 'false'
    })
  })
})

describe('Codex option picks before the model list arrives', () => {
  it('accepts launch-held model, effort and Fast picks while its own listing is held', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1'
    })
    await vi.waitFor(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(true)
    )
    const pick = (key: string, value: string) =>
      adapter.setOption({ sessionId: 'session-1', key, value, fence: 7 })

    await expect(pick('model', 'gpt-next')).resolves.toMatchObject({ model: 'gpt-next' })
    await expect(pick('effort', 'low')).resolves.toMatchObject({ model: 'gpt-next', effort: 'low' })
    await expect(pick('fastMode', 'true')).resolves.toEqual({
      model: 'gpt-next',
      effort: 'low',
      fastMode: 'true'
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'first',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'gpt-next', effort: 'low', serviceTier: 'default' })
    expect(codex.connections[0].calls.filter((call) => call.method === 'model/list')).toHaveLength(
      1
    )
    pending.resolve({ data: [], nextCursor: null })
  })
})
