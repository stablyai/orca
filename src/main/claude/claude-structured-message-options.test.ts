import { describe, expect, it, vi } from 'vitest'
import {
  acquired,
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  USER_MESSAGE
} from './claude-structured-session-test-support'
import { captureStructuredExecutionOptions } from '../native-chat/agent-session-wire/structured-agent-session-execution-options'
import { claudeAndCodexAgents } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { ClaudeControlRequestError } from './claude-stream-json-connection'

const MODELS = [
  { value: 'default', resolvedModel: 'claude-sonnet-5' },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  }
]

describe('Claude accepted message choices', () => {
  it.each([false, true])(
    'delivers resumed choices despite optional reports (alias listed: %s)',
    async (listed) => {
      const saved = { model: 'opus[1m]', effort: 'high', fastMode: 'false' } as const
      const models = listed ? [...MODELS, { value: saved.model }] : MODELS
      const claude = fakeClaude({ initModels: models, routes: { list_models: () => models } })
      const adapter = adapterFor(claude, { resumesTranscript: true })
      await adapter.acquire({
        identity: identityFor(),
        fence: 7,
        spawnToken: 'resume',
        options: saved,
        events: recordingJournalSink()
      })
      const connection = claude.connections[0]!
      claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-5' })
      connection.calls.length = 0
      for (const clientMessageId of ['restart', 'followup']) {
        await expect(
          adapter.dispatch({
            sessionId: 'session-1',
            clientMessageId,
            body: USER_MESSAGE,
            executionOptions: saved,
            fence: 7
          })
        ).resolves.toMatchObject({ state: 'admitted' })
        await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
      }
      expect(
        connection.calls.filter((call) =>
          ['set_model', 'apply_flag_settings'].includes(call.subtype)
        )
      ).toEqual([])
      for (const clientMessageId of ['changed', 'unchanged']) {
        await expect(
          adapter.dispatch({
            sessionId: 'session-1',
            clientMessageId,
            body: USER_MESSAGE,
            executionOptions: { ...saved, model: 'custom[1m]', effort: 'low' },
            fence: 7
          })
        ).resolves.toMatchObject({ state: 'admitted' })
      }
      expect(
        connection.calls.filter((call) =>
          ['set_model', 'apply_flag_settings'].includes(call.subtype)
        )
      ).toEqual([
        { subtype: 'set_model', params: { model: 'custom[1m]' } },
        { subtype: 'apply_flag_settings', params: { settings: { effortLevel: 'low' } } }
      ])
      const failure = new Error('control refused')
      connection.setModel = async () => {
        throw failure
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await expect(
          adapter.dispatch({
            sessionId: 'session-1',
            clientMessageId: `refused-${listed}`,
            body: USER_MESSAGE,
            executionOptions: { model: 'another' },
            fence: 7
          })
        ).resolves.toMatchObject({ state: 'rejected' })
        expect(connection.sent).toHaveLength(4)
        expect(warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ error: failure })
        )
      } finally {
        warn.mockRestore()
      }
    }
  )

  it.each([
    ['the effort the CLI applied over the settings level', 'low', { effort: 'low' }],
    ['no effort where the CLI applies none, whatever the settings say', null, {}]
  ])('reports %s', async (_name, applied, ranOptions) => {
    let effortLevel = 'high'
    const claude = fakeClaude({
      routes: {
        list_models: () => MODELS,
        apply_flag_settings: ({ settings } = {}) => {
          effortLevel = JSON.stringify(settings).includes('low') ? 'low' : effortLevel
        }
      },
      settings: {
        applied: { model: 'claude-sonnet-5', effort: applied },
        get effective() {
          return { effortLevel }
        }
      }
    })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: 'options-reported' }))
    )
    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'm',
      body: USER_MESSAGE,
      executionOptions: {},
      fence: 7
    })
    expect(outcome).toEqual({
      state: 'admitted',
      ranOptions: applied ? { model: 'claude-sonnet-5', ...ranOptions } : {}
    })
  })

  it('applies a held message A before its prompt, then message B on the existing child', async () => {
    const order: string[] = []
    let currentEffort = 'high'
    const claude = fakeClaude({
      routes: {
        list_models: () => MODELS,
        set_model: ({ model } = {}) => order.push(`model:${String(model)}`),
        apply_flag_settings: ({ settings } = {}) => {
          order.push(`effort:${JSON.stringify(settings)}`)
          if (
            typeof settings === 'object' &&
            settings !== null &&
            'effortLevel' in settings &&
            typeof settings.effortLevel === 'string'
          ) {
            currentEffort = settings.effortLevel
          }
        }
      }
    })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]!
    connection.getSettings = async () => ({ effective: { effortLevel: currentEffort } })
    const send = connection.send
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredSend = new Promise<void>((resolve) => {
      entered = resolve
    })
    let first = true
    connection.send = async (message, beforeDispatch) => {
      if (first) {
        first = false
        entered()
        await held
      }
      const result = await send(message, beforeDispatch)
      order.push('prompt')
      return result
    }

    const a = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'A',
      body: USER_MESSAGE,
      executionOptions: { model: 'sonnet', effort: 'low' },
      fence: 7
    })
    await enteredSend
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    order.length = 0
    release()
    await expect(a).resolves.toMatchObject({ state: 'admitted' })
    expect(order).toEqual(['model:sonnet', 'effort:{"effortLevel":"low"}', 'prompt'])

    order.length = 0
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'B',
        body: USER_MESSAGE,
        executionOptions: { model: 'opus', effort: 'high' },
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(order).toEqual(['model:opus', 'effort:{"effortLevel":"high"}', 'prompt'])
  })

  // Host admission treats the original abort as never written.
  it('surfaces a Stop while it applies a choice as the abort, and a refusal as a refusal', async () => {
    let refuse = false
    const claude = fakeClaude({
      initModels: MODELS,
      routes: {
        list_models: () => MODELS,
        set_model: () => {
          if (refuse) {
            throw new ClaudeControlRequestError('set_model', 'unknown model')
          }
          return new Promise(() => {})
        }
      }
    })
    const adapter = await acquired(claude)
    const stop = new AbortController()
    const dispatch = (clientMessageId: string, signal?: AbortSignal) =>
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId,
        body: USER_MESSAGE,
        executionOptions: { model: 'opus' },
        fence: 7,
        ...(signal ? { signal } : {})
      })
    const stopped = dispatch('stopped', stop.signal)
    await vi.waitFor(() =>
      expect(claude.connections[0]!.calls.some((call) => call.subtype === 'set_model')).toBe(true)
    )
    stop.abort(new Error('stopped while starting'))
    await expect(stopped).rejects.toBe(stop.signal.reason)
    refuse = true
    await expect(dispatch('refused')).resolves.toMatchObject({
      state: 'rejected',
      rejection: { kind: 'providerRejected' }
    })
    expect(claude.connections[0]!.sent).toHaveLength(0)
  })

  it('restores A after an applied unanswered B and an uncorrelated old init', async () => {
    let actual: string | undefined = 'sonnet'
    const claude = fakeClaude({ initModels: MODELS, routes: { list_models: () => MODELS } })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]!
    connection.setModel = async (model) => {
      actual = model
      if (model === 'opus') {
        throw new Error('answer lost')
      }
    }
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'sonnet', fence: 7 })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    ).rejects.toThrow('answer lost')
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'sonnet' })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'restore',
        body: USER_MESSAGE,
        executionOptions: { model: 'sonnet' },
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(actual).toBe('sonnet')
    expect(connection.sent).toHaveLength(1)
  })

  it('keeps saved Fast for an older partial send, freezes it, and honors explicit false', async () => {
    let fastMode = true
    const supported = MODELS.map((model) => ({ ...model, supportsFastMode: true }))
    const claude = fakeClaude({
      initModels: supported,
      routes: {
        list_models: () => supported,
        apply_flag_settings: ({ settings } = {}) => {
          if (
            typeof settings === 'object' &&
            settings !== null &&
            'fastMode' in settings &&
            typeof settings.fastMode === 'boolean'
          ) {
            fastMode = settings.fastMode
          }
        }
      }
    })
    const adapter = await acquired(claude)
    const saved = { model: 'sonnet', effort: 'high', fastMode: 'true' }
    const ctx = { agents: claudeAndCodexAgents(), agent: 'claude', persistedOptions: saved }
    const captured = captureStructuredExecutionOptions(ctx, { model: 'sonnet', effort: 'high' })
    if ('refusal' in captured) {
      throw new Error(captured.refusal.message)
    }
    saved.fastMode = 'false'
    const connection = claude.connections[0]!
    connection.getSettings = async () => ({ effective: { effortLevel: 'high', fastMode } })
    for (const [id, options] of [
      ['old', captured.options],
      ['off', { ...captured.options, fastMode: 'false' }]
    ] as const) {
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId: id,
          body: USER_MESSAGE,
          executionOptions: options,
          fence: 7
        })
      ).resolves.toMatchObject({ state: 'admitted' })
    }
    expect(captured.options.fastMode).toBe('true')
    expect(connection.calls.filter((call) => call.subtype === 'apply_flag_settings')).toEqual(
      expect.arrayContaining([
        { subtype: 'apply_flag_settings', params: { settings: { fastMode: true } } },
        { subtype: 'apply_flag_settings', params: { settings: { fastMode: false } } }
      ])
    )
    expect(connection.sent).toHaveLength(2)
  })

  it('restores the configured model and effort for an empty snapshot', async () => {
    let currentEffort = 'high'
    const claude = fakeClaude({
      routes: {
        list_models: () => MODELS,
        apply_flag_settings: ({ settings } = {}) => {
          if (
            typeof settings === 'object' &&
            settings !== null &&
            'effortLevel' in settings &&
            typeof settings.effortLevel === 'string'
          ) {
            currentEffort = settings.effortLevel
          }
        }
      }
    })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: 'options-reported' }))
    )
    claude.connections[0]!.getSettings = async () => ({ effective: { effortLevel: currentEffort } })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'A',
      body: USER_MESSAGE,
      executionOptions: { model: 'opus', effort: 'low' },
      fence: 7
    })
    const connection = claude.connections[0]!
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-5' })
    connection.calls.length = 0
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'default',
        body: USER_MESSAGE,
        executionOptions: {},
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(
      connection.calls.filter((call) => ['set_model', 'apply_flag_settings'].includes(call.subtype))
    ).toEqual([
      { subtype: 'set_model', params: { model: 'claude-sonnet-5' } },
      { subtype: 'apply_flag_settings', params: { settings: { effortLevel: 'high' } } }
    ])
    expect(connection.sent).toHaveLength(2)
  })
})
