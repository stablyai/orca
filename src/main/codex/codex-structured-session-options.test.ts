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
import { reportedCodexThreadOptions } from './codex-structured-service-tier'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSession } from './codex-structured-session-state'
import { startCodexTurn } from './codex-structured-turn-start'
import {
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'

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
    ['serviceTier', 'ultrafast']
  ])('keeps a cold %s pick as intent without starting a model request', async (key, value) => {
    const request = vi.fn(async () => ({ data: [] }))
    const session = optionSession(request)

    await expect(applyCodexStructuredSessionOption(session, key, value)).resolves.toMatchObject({
      [key]: value
    })
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
      serviceTier: 'default'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses an older client Fast on while nothing names the Fast tier', async () => {
    const session = optionSession(vi.fn(async () => ({ data: [] })))

    await expect(applyCodexStructuredSessionOption(session, 'fastMode', 'true')).rejects.toThrow(
      'does not support Fast mode'
    )
    expect(session.options.has('serviceTier')).toBe(false)
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
    expect(Object.fromEntries(restoredCodexSessionOptions({ serviceTier: 'priority' }))).toEqual({
      serviceTier: 'priority'
    })
    // Fast on/off saved before tiers is not carried over.
    expect(Object.fromEntries(restoredCodexSessionOptions({ fastMode: 'true' }))).toEqual({})
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
    ).resolves.toMatchObject({ serviceTier: 'rush-v7' })
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
    ).resolves.toMatchObject({
      current: {
        serviceTier: 'priority-current',
        fastMode: true,
        confirmed: ['serviceTier', 'fastMode']
      }
    })
    const unknown = await readCodexStructuredSessionOptions({
      connection,
      current: { model: 'gpt-live' },
      reportedServiceTier: 'unrecognized-tier',
      reportedServiceTierKnown: true
    })
    expect(unknown.current).toEqual({
      model: 'gpt-live',
      serviceTier: 'unrecognized-tier',
      confirmed: ['serviceTier']
    })
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

  it('drops a restored tier to Standard when the selected model no longer lists it', async () => {
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
    session.options.set('serviceTier', 'priority')

    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { serviceTier: 'default', fastMode: false }
    })
    expect(Object.fromEntries(session.options)).toEqual({ serviceTier: 'default' })

    await startCodexTurn(session, {
      clientMessageId: 'message-standard',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'standard' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'default'
    })
  })

  it('sends a restored tier before any listing names it', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    const session = optionSession(
      vi.fn(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params })
        return method === 'turn/start'
          ? { turn: { id: 'turn-unlisted' } }
          : { data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }], nextCursor: null }
      })
    )
    session.options.set('serviceTier', 'priority-saved')

    const options = await readLiveCodexSessionOptions(session, undefined)
    expect(options.current).toMatchObject({ serviceTier: 'priority-saved' })
    expect(options.current).not.toHaveProperty('fastMode')
    expect(options.models[0]?.serviceTiers).toBeUndefined()
    await startCodexTurn(session, {
      clientMessageId: 'message-unlisted',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'unlisted' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'priority-saved'
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
    ).resolves.toMatchObject({ serviceTier: 'default' })
    await startCodexTurn(session, {
      clientMessageId: 'message-standard',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'standard' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'default'
    })
  })

  it('falls back to the legacy Fast tier beside an empty service tier list', async () => {
    const result = await readCodexStructuredSessionOptions({
      connection: {
        request: vi.fn(async () => ({
          data: [
            {
              model: 'gpt-live',
              supportedReasoningEfforts: [],
              serviceTiers: [],
              additionalSpeedTiers: ['fast']
            }
          ],
          nextCursor: null
        }))
      },
      current: { model: 'gpt-live' }
    })
    expect(result.models[0]).toMatchObject({
      supportsFastMode: true,
      serviceTiers: [{ value: 'fast', label: 'Fast' }]
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
    expect(result.models[0]).toMatchObject({
      supportsFastMode: true,
      serviceTiers: [{ value: 'fast', label: 'Fast' }]
    })
    expect(result.fastModeSupport).toEqual({ supported: true })
  })

  it('drops to Standard when switching to a model without the picked tier', async () => {
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
    session.options.set('serviceTier', 'priority-x')
    await primePicker(session)

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-standard')
    ).resolves.toMatchObject({ model: 'gpt-standard', serviceTier: 'default' })
  })
})

describe('Codex service tiers', () => {
  const tierListing = {
    data: [
      {
        model: 'gpt-6.1-sol',
        supportedReasoningEfforts: [],
        serviceTiers: [
          { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
          { id: 'ultrafast', name: 'Ultrafast', description: '3x speed' }
        ]
      },
      {
        model: 'gpt-6-luna',
        supportedReasoningEfforts: [],
        serviceTiers: [{ id: 'priority', name: 'Fast' }]
      }
    ],
    nextCursor: null
  }

  it('lists every tier a model advertises, valued by its id', async () => {
    const result = await readCodexStructuredSessionOptions({
      connection: { request: vi.fn(async () => tierListing) },
      current: { model: 'gpt-6.1-sol' }
    })
    expect(result.models[0]).toMatchObject({
      supportsFastMode: true,
      serviceTiers: [
        { value: 'priority', label: 'Fast', description: '2x speed, increased usage' },
        { value: 'ultrafast', label: 'Ultrafast', description: '3x speed' }
      ]
    })
    expect(result.models[1]?.serviceTiers).toEqual([{ value: 'priority', label: 'Fast' }])
  })

  it('sends Ultrafast as its id and reports it to older clients as neither on nor off', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    const session = optionSession(
      vi.fn(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params })
        return method === 'model/list' ? tierListing : { turn: { id: 'turn-ultrafast' } }
      })
    )
    session.reportedOptions = { model: 'gpt-6.1-sol' }
    await primePicker(session)

    await expect(
      applyCodexStructuredSessionOption(session, 'serviceTier', 'ultrafast')
    ).resolves.toMatchObject({ serviceTier: 'ultrafast' })
    const options = await readLiveCodexSessionOptions(session, undefined)
    expect(options.current).toMatchObject({ serviceTier: 'ultrafast' })
    expect(options.current).not.toHaveProperty('fastMode')
    await startCodexTurn(session, {
      clientMessageId: 'message-ultrafast',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'ultrafast'
    })
  })

  it('refuses a tier the model does not list and drops to Standard on a switch to one', async () => {
    const session = optionSession(vi.fn(async () => tierListing))
    session.reportedOptions = { model: 'gpt-6-luna' }
    await primePicker(session)

    await expect(
      applyCodexStructuredSessionOption(session, 'serviceTier', 'ultrafast')
    ).rejects.toThrow('does not offer the ultrafast tier')
    await applyCodexStructuredSessionOption(session, 'model', 'gpt-6.1-sol')
    await applyCodexStructuredSessionOption(session, 'serviceTier', 'ultrafast')
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-6-luna')
    ).resolves.toMatchObject({ model: 'gpt-6-luna', serviceTier: 'default' })
  })
})

describe('Codex reported tier', () => {
  const listing = {
    data: [
      {
        model: 'gpt-6.1-sol',
        supportedReasoningEfforts: [],
        serviceTiers: [
          { id: 'priority', name: 'Fast' },
          { id: 'ultrafast', name: 'Ultrafast' }
        ]
      },
      {
        model: 'gpt-6-luna',
        supportedReasoningEfforts: [],
        serviceTiers: [{ id: 'priority', name: 'Fast' }]
      }
    ],
    nextCursor: null
  }

  it('never rewrites a tier Codex reports, such as a configured Flex', async () => {
    const session = optionSession(vi.fn(async () => listing))
    session.reportedOptions = { model: 'gpt-6.1-sol', serviceTier: 'flex', serviceTierKnown: true }
    await primePicker(session)

    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { serviceTier: 'flex' }
    })
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-6-luna')
    ).resolves.toEqual({ model: 'gpt-6-luna' })
  })

  it('keeps a re-picked reported Flex through a read, a model switch, and the next message', async () => {
    const requests: { method: string; params?: Record<string, unknown> }[] = []
    const session = optionSession(
      vi.fn(async (method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params })
        return method === 'model/list' ? listing : { turn: { id: 'turn-flex' } }
      })
    )
    session.reportedOptions = { model: 'gpt-6.1-sol', serviceTier: 'flex', serviceTierKnown: true }
    await primePicker(session)

    await applyCodexStructuredSessionOption(session, 'serviceTier', 'ultrafast')
    await expect(
      applyCodexStructuredSessionOption(session, 'serviceTier', 'flex')
    ).resolves.toEqual({ serviceTier: 'flex' })
    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { serviceTier: 'flex' }
    })
    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-6-luna')
    ).resolves.toEqual({ model: 'gpt-6-luna', serviceTier: 'flex' })
    await startCodexTurn(session, {
      clientMessageId: 'message-flex',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'flex'
    })
  })

  it.each([
    ['untouched', []],
    ['re-picked', ['priority', 'ultrafast']]
  ])(
    'resets a %s reported tier another model lists on a switch to a model without it',
    async (_case, picks) => {
      const session = optionSession(vi.fn(async () => listing))
      session.reportedOptions = {
        model: 'gpt-6.1-sol',
        serviceTier: 'ultrafast',
        serviceTierKnown: true
      }
      await primePicker(session)
      for (const pick of picks) {
        await applyCodexStructuredSessionOption(session, 'serviceTier', pick)
      }

      await expect(
        applyCodexStructuredSessionOption(session, 'model', 'gpt-6-luna')
      ).resolves.toEqual({ model: 'gpt-6-luna', serviceTier: 'default' })
      await expect(
        applyCodexStructuredSessionOption(session, 'serviceTier', 'ultrafast')
      ).rejects.toThrow('does not offer the ultrafast tier')
    }
  )
})

describe('Codex option picks before the model list arrives', () => {
  it('accepts launch-held model, effort and tier picks while its own listing is held', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-1' })
    await vi.waitFor(() =>
      expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(true)
    )
    const pick = (key: string, value: string) =>
      adapter.setOption({ sessionId: 'session-1', key, value, fence: 7 })

    await expect(pick('model', 'gpt-next')).resolves.toMatchObject({ model: 'gpt-next' })
    await expect(pick('effort', 'low')).resolves.toMatchObject({ model: 'gpt-next', effort: 'low' })
    await expect(pick('serviceTier', 'priority')).resolves.toEqual({
      model: 'gpt-next',
      effort: 'low',
      serviceTier: 'priority'
    })
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toEqual({
      model: 'gpt-next',
      effort: 'low',
      serviceTier: 'priority'
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'first',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'gpt-next', effort: 'low', serviceTier: 'priority' })
    expect(codex.connections[0].calls.filter((call) => call.method === 'model/list')).toHaveLength(
      1
    )
    pending.resolve({ data: [], nextCursor: null })
  })
})
