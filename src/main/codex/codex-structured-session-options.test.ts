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
    requestedClose: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    historyPath: null,
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    fastModeTierByModel: new Map(),
    turnIdWaiters: [],
    translator: null
  }
}

describe('structured Codex session options', () => {
  it('filters restored records to recognized turn options', () => {
    expect(
      Object.fromEntries(
        restoredCodexSessionOptions({
          model: 'gpt-live',
          effort: 'high',
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
        historyPath: null,
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

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-fast', undefined)
    ).resolves.toEqual({ model: 'gpt-fast', effort: 'low' })
  })

  it('rejects values absent from the provider catalog', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'not-entitled', undefined)
    ).rejects.toThrow('does not offer model not-entitled')
    await expect(
      applyCodexStructuredSessionOption(session, 'effort', 'high', undefined)
    ).rejects.toThrow('does not support high')
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

    await expect(
      applyCodexStructuredSessionOption(session, 'fastMode', 'true', undefined)
    ).resolves.toMatchObject({ fastMode: 'true' })
    await startCodexTurn(session, {
      clientMessageId: 'message-on',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'on' }] }
    })
    expect(requests.find((entry) => entry.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'rush-v7'
    })

    await applyCodexStructuredSessionOption(session, 'fastMode', 'false', undefined)
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

    await expect(
      readCodexStructuredSessionOptions({
        connection: session.connection,
        current: { model: 'gpt-live' }
      })
    ).resolves.toMatchObject({
      models: [expect.objectContaining({ supportsFastMode: false })],
      fastModeSupport: { supported: false }
    })
    await expect(
      applyCodexStructuredSessionOption(session, 'fastMode', 'true', undefined)
    ).rejects.toThrow('does not support Fast mode')
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
      applyCodexStructuredSessionOption(session, 'fastMode', 'false', undefined)
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

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-standard', undefined)
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
      applyCodexStructuredSessionOption(session, 'serviceTier', 'priority', undefined)
    ).rejects.toThrow('cannot be set directly')
    expect(session.options.has('serviceTier')).toBe(false)

    expect(Object.fromEntries(restoredCodexSessionOptions({ serviceTier: 'default' }))).toEqual({
      fastMode: 'false'
    })
  })
})
