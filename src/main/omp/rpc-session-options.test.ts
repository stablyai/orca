import { afterEach, expect, it, vi } from 'vitest'
import { state } from '../pi/rpc-session-adapter.test-fixture'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

const identity = { sessionId: 'omp-test', fence: 1 }
const nextModel = { provider: 'github-copilot', id: 'other', api: 'openai-responses' }

async function setup() {
  const h = await setupOmpRpcAdapter()
  await vi.waitFor(() => expect(h.adapter.readCommands(identity.sessionId)).toBeDefined())
  let modelChanged = false
  let thinkingChanged = false
  h.connection.requestOverride = (command) => {
    if (command === 'goal') {
      return Promise.resolve({ goal: null })
    }
    if (command === 'set_model') {
      modelChanged = true
      return Promise.resolve({})
    }
    if (command === 'set_thinking_level') {
      thinkingChanged = true
      return Promise.resolve({})
    }
    if (command === 'get_available_models') {
      return Promise.resolve({ models: [nextModel] })
    }
    if (command === 'get_state') {
      return Promise.resolve({
        ...state,
        model: modelChanged ? nextModel : { ...state.model, api: 'anthropic-messages' },
        thinkingLevel: thinkingChanged ? 'low' : 'high',
        fastModeEnabled: true,
        fastModeActive: !modelChanged
      })
    }
    return undefined
  }
  h.connection.receive({ type: 'config_update' })
  await vi.waitFor(async () =>
    expect((await h.adapter.readOptions(identity)).current.fastModeState).toBe('on')
  )
  const request = vi.spyOn(h.connection, 'request')
  return { ...h, request }
}

it('refreshes native Fast metadata when a Goal changes its execution model', async () => {
  const h = await setup()
  await expect(
    h.adapter.changeThreadGoal({
      ...identity,
      replacesGoal: false,
      change: { kind: 'clear' },
      executionOptions: { model: 'github-copilot/other' }
    })
  ).resolves.toEqual({ ok: true })
  expect(await h.adapter.readOptions(identity)).toMatchObject({
    current: { model: 'github-copilot/other', fastMode: true, fastModeState: 'off' },
    fastModeSupport: { supported: false, reason: 'model-not-supported' }
  })
  expect(h.request).toHaveBeenCalledWith('get_state')
  h.request.mockClear()
  await h.adapter.readOptions(identity)
  expect(h.request).not.toHaveBeenCalled()
})

it('refreshes options applied directly during message dispatch', async () => {
  const h = await setup()
  await expect(
    h.adapter.dispatch({
      ...identity,
      clientMessageId: 'changed-model',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
      executionOptions: { model: 'github-copilot/other' }
    })
  ).resolves.toMatchObject({ state: 'admitted' })
  expect(await h.adapter.readOptions(identity)).toMatchObject({
    current: { model: 'github-copilot/other', fastModeState: 'off' },
    fastModeSupport: { supported: false }
  })
})

it('refreshes a Goal Thinking write while retaining native Fast state', async () => {
  const h = await setup()
  await expect(
    h.adapter.changeThreadGoal({
      ...identity,
      replacesGoal: false,
      change: { kind: 'clear' },
      executionOptions: { effort: 'low' }
    })
  ).resolves.toEqual({ ok: true })
  expect((await h.adapter.readOptions(identity)).current).toMatchObject({
    effort: 'low',
    fastMode: true,
    fastModeState: 'on',
    confirmed: expect.arrayContaining(['effort', 'fastMode'])
  })
  expect(h.request).toHaveBeenCalledWith('get_state')
})

it.each(['get_available_models', 'get_state'])(
  'does not reject or replay an admitted message when %s cannot refresh',
  async (failedCommand) => {
    const h = await setup()
    const previous = h.connection.requestOverride
    h.connection.requestOverride = (command) =>
      command === failedCommand
        ? Promise.reject(new Error('Temporary discovery failure'))
        : previous?.(command)
    await expect(
      h.adapter.dispatch({
        ...identity,
        clientMessageId: 'refresh-failed',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
        executionOptions: { model: 'github-copilot/other' }
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(h.connection.sent.filter((frame) => frame.type === 'prompt')).toHaveLength(1)
    expect((await h.adapter.readOptions(identity)).current.model).toBe('github-copilot/other')
    expect(h.connection.closed).toBe(false)
  }
)

it('refreshes a successful dispatch model write when its following Thinking write is rejected', async () => {
  const h = await setup()
  const previous = h.connection.requestOverride
  h.connection.requestOverride = (command) =>
    command === 'set_thinking_level'
      ? Promise.reject(new JsonlRpcResponseError(command, 'Thinking unavailable'))
      : previous?.(command)
  await expect(
    h.adapter.dispatch({
      ...identity,
      clientMessageId: 'thinking-rejected',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] },
      executionOptions: { model: 'github-copilot/other', effort: 'low' }
    })
  ).rejects.toThrow('Thinking unavailable')
  expect(await h.adapter.readOptions(identity)).toMatchObject({
    current: { model: 'github-copilot/other', fastModeState: 'off' },
    fastModeSupport: { supported: false }
  })
  expect(h.connection.sent).toEqual([])
})

it('does not discover options when a dispatch reuses already applied choices', async () => {
  const h = await setup()
  const input = {
    ...identity,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'Continue' }]
    },
    executionOptions: { model: 'github-copilot/other', effort: 'low' }
  }
  await h.adapter.dispatch({ ...input, clientMessageId: 'first' })
  h.request.mockClear()
  await h.adapter.dispatch({ ...input, clientMessageId: 'second' })
  expect(h.request).not.toHaveBeenCalled()
})

it('applies a carried Fast choice before writing a message', async () => {
  const h = await setup()
  const previous = h.connection.requestOverride
  h.connection.requestOverride = (command) =>
    command === 'set_fast_mode'
      ? Promise.resolve({ enabled: false, active: false })
      : previous?.(command)
  const sent = vi.spyOn(h.connection, 'send')
  const outcome = await h.adapter.dispatch({
    ...identity,
    clientMessageId: 'fast-choice',
    executionOptions: { fastMode: 'false' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
  })
  expect(h.request).toHaveBeenCalledWith('set_fast_mode', { enabled: false })
  expect(h.request.mock.invocationCallOrder[0]).toBeLessThan(sent.mock.invocationCallOrder[0] ?? 0)
  expect(outcome).toMatchObject({ state: 'admitted', ranOptions: { fastMode: 'false' } })
})

it('does not write a prompt when OMP rejects its carried Fast choice', async () => {
  const h = await setup()
  const previous = h.connection.requestOverride
  h.connection.requestOverride = (command) =>
    command === 'set_fast_mode'
      ? Promise.reject(new JsonlRpcResponseError(command, 'Fast unavailable'))
      : previous?.(command)
  await expect(
    h.adapter.dispatch({
      ...identity,
      clientMessageId: 'fast-rejected',
      executionOptions: { fastMode: 'true' },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
    })
  ).rejects.toThrow('Fast unavailable')
  expect(h.connection.sent).toEqual([])
  expect(h.connection.closed).toBe(false)
})

it('applies Goal Fast choices through the native control', async () => {
  const h = await setup()
  const previous = h.connection.requestOverride
  h.connection.requestOverride = (command) =>
    command === 'set_fast_mode'
      ? Promise.resolve({ enabled: false, active: false })
      : previous?.(command)
  await expect(
    h.adapter.changeThreadGoal({
      ...identity,
      replacesGoal: false,
      change: { kind: 'clear' },
      executionOptions: { fastMode: 'false' }
    })
  ).resolves.toEqual({ ok: true })
  expect(h.request.mock.calls.map(([command]) => command)).toEqual([
    'goal',
    'set_fast_mode',
    'goal'
  ])
  expect((await h.adapter.readOptions(identity)).current).toMatchObject({
    fastMode: false,
    fastModeState: 'off'
  })
})

it('reapplies a carried Fast choice after an external native configuration change', async () => {
  const h = await setup()
  const previous = h.connection.requestOverride
  h.connection.requestOverride = (command) =>
    command === 'set_fast_mode'
      ? Promise.resolve({ enabled: true, active: true })
      : previous?.(command)
  await h.adapter.setOption({ ...identity, key: 'fastMode', value: 'true' })
  h.request.mockClear()
  h.connection.receive({ type: 'config_update' })
  await h.adapter.dispatch({
    ...identity,
    clientMessageId: 'fast-after-native-change',
    executionOptions: { fastMode: 'true' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
  })
  expect(h.request).toHaveBeenCalledWith('set_fast_mode', { enabled: true })
})

it('reapplies a model choice after a native configuration event invalidates the previous control', async () => {
  const h = await setup()
  await h.adapter.setOption({ ...identity, key: 'model', value: 'github-copilot/other' })
  h.connection.receive({ type: 'config_update' })
  await vi.waitFor(async () =>
    expect((await h.adapter.readOptions(identity)).current.model).toBe('github-copilot/other')
  )
  h.request.mockClear()
  await h.adapter.dispatch({
    ...identity,
    clientMessageId: 'model-after-native-change',
    executionOptions: { model: 'github-copilot/other' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
  })
  expect(h.request).toHaveBeenCalledWith(
    'set_model',
    { provider: 'github-copilot', modelId: 'other' },
    { timeoutMs: undefined }
  )
})

it('reapplies Fast after a command changes it without a configuration event', async () => {
  const h = await setup()
  const previous = h.connection.requestOverride
  h.connection.requestOverride = (command) => {
    if (command === 'set_fast_mode') {
      return Promise.resolve({ enabled: true, active: true })
    }
    if (command === 'get_state') {
      return Promise.resolve({
        ...state,
        model: { ...state.model, api: 'anthropic-messages' },
        fastModeEnabled: false,
        fastModeActive: false
      })
    }
    return previous?.(command)
  }
  await h.adapter.setOption({ ...identity, key: 'fastMode', value: 'true' })
  h.connection.receive({ type: 'prompt_result', status: 'completed', sessionSettled: true })
  await vi.waitFor(async () =>
    expect((await h.adapter.readOptions(identity)).current.fastMode).toBe(false)
  )
  h.request.mockClear()
  await h.adapter.dispatch({
    ...identity,
    clientMessageId: 'fast-after-command',
    executionOptions: { fastMode: 'true' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
  })
  expect(h.request).toHaveBeenCalledWith('set_fast_mode', { enabled: true })
})

it.each(['get_available_models', 'get_state'])(
  'keeps a successful Goal option write when %s cannot refresh',
  async (failedCommand) => {
    const h = await setup()
    const previous = h.connection.requestOverride
    const failure = new Error('Temporary discovery failure')
    h.connection.requestOverride = (command) =>
      command === failedCommand ? Promise.reject(failure) : previous?.(command)
    await expect(
      h.adapter.changeThreadGoal({
        ...identity,
        replacesGoal: false,
        change: { kind: 'clear' },
        executionOptions: { model: 'github-copilot/other' }
      })
    ).resolves.toEqual({ ok: true })
    expect((await h.adapter.readOptions(identity)).current.model).toBe('github-copilot/other')
    expect(h.connection.closed).toBe(false)
    expect(h.logger.warn).toHaveBeenCalledWith(
      'OMP options could not be refreshed after a write',
      expect.objectContaining({ error: failure })
    )
  }
)

it('refreshes a successful Goal model write even when its following Thinking write is rejected', async () => {
  const h = await setup()
  const previous = h.connection.requestOverride
  h.connection.requestOverride = (command) =>
    command === 'set_thinking_level'
      ? Promise.reject(new JsonlRpcResponseError(command, 'Thinking unavailable'))
      : previous?.(command)
  await expect(
    h.adapter.changeThreadGoal({
      ...identity,
      replacesGoal: false,
      change: { kind: 'clear' },
      executionOptions: { model: 'github-copilot/other', effort: 'low' }
    })
  ).resolves.toEqual({ ok: false, rejected: 'Thinking unavailable' })
  expect(await h.adapter.readOptions(identity)).toMatchObject({
    current: { model: 'github-copilot/other', fastModeState: 'off' },
    fastModeSupport: { supported: false }
  })
  expect(h.request.mock.calls.filter(([command]) => command === 'goal')).toHaveLength(1)
})

it('does not discover options for a Goal that applies no execution choices', async () => {
  const h = await setup()
  await expect(
    h.adapter.changeThreadGoal({
      ...identity,
      replacesGoal: false,
      change: { kind: 'clear' }
    })
  ).resolves.toEqual({ ok: true })
  expect(h.request.mock.calls.map(([command]) => command)).toEqual(['goal', 'goal'])
})
