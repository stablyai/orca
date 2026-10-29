import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  file,
  reportedEvent,
  restart,
  sessionId,
  setup,
  state
} from './rpc-session-adapter.test-fixture'

function openAt8(h: Awaited<ReturnType<typeof setup>>, acquisitionGeneration: string) {
  return h.adapter.open({
    sessionId,
    fence: 8,
    acquisitionGeneration,
    signal: new AbortController().signal
  })
}

afterEach(closePiRpcAdapterFixtures)

describe('Pi host awaited open', () => {
  it('lets the host close a child held in the state request without a late open', async () => {
    const h = await setup()
    const stateReply = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state' ? stateReply.promise : undefined
      connection.abortRequest = () => stateReply.reject(new Error('closed while starting'))
    })
    const controller = new AbortController()
    const opening = h.adapter
      .open({
        sessionId,
        fence: 8,
        acquisitionGeneration: acquired.acquisitionGeneration ?? null,
        signal: controller.signal
      })
      .catch((error: unknown) => error)
    expect(child.requests).toEqual(['get_state'])
    controller.abort()
    await h.adapter.closeSession(sessionId)
    expect(await opening).toBeInstanceOf(Error)
    expect(child.rootVerdict).toBe('exited')
    expect(h.lifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }))
  })

  it('fails an open if its lane fails while the state request is pending', async () => {
    const h = await setup()
    const stateReply = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state' ? stateReply.promise : undefined
    })
    const opening = h.adapter.open({
      sessionId,
      fence: 8,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null,
      signal: new AbortController().signal
    })
    child.handlers.onClose?.(new Error('lane failed during startup'))
    stateReply.resolve(state)
    await expect(opening).rejects.toThrow('lane failed during startup')
  })

  it('is ready once Pi reports its state; the listing follows, and an empty one fails nothing', async () => {
    const h = await setup()
    const listing = Promise.withResolvers<unknown>()
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_available_models' ? listing.promise : undefined
    })
    await expect(openAt8(h, acquired.acquisitionGeneration)).resolves.toMatchObject({
      reportedOptions: { model: 'anthropic/model-1' }
    })
    expect(h.lifecycle).not.toHaveBeenCalled()
    listing.resolve({ models: [] })
    await vi.waitFor(() => expect(reportedEvent(h.lifecycle, 'options-reported').fence).toBe(8))
    expect(child.closed).toBe(false)
    await vi.waitFor(() =>
      expect(h.adapter.readCommands(sessionId)).toMatchObject([{ name: 'help' }])
    )
  })

  it('fails the start when Pi runs the unknown provider', async () => {
    const h = await setup()
    const unknown = { ...state, model: { provider: 'unknown', id: 'unknown' } }
    const { acquired } = await restart(h, (connection) => {
      connection.requestOverride = (command) =>
        command === 'get_state' ? Promise.resolve(unknown) : undefined
    })
    await expect(openAt8(h, acquired.acquisitionGeneration)).rejects.toMatchObject({
      reason: 'notSignedIn'
    })
  })

  it('learns the immutable opening model and effort while listing spans a message switch', async () => {
    const h = await setup()
    const listing = Promise.withResolvers<unknown>()
    let current = { ...state, thinkingLevel: 'low' }
    const { acquired, child } = await restart(h, (connection) => {
      connection.requestOverride = (command) => {
        if (command === 'get_available_models') {
          return listing.promise
        }
        if (command === 'get_state') {
          return Promise.resolve(current)
        }
        if (command === 'set_model') {
          current = { ...current, model: { provider: 'anthropic', id: 'model-2' } }
        }
        if (command === 'set_thinking_level') {
          current = { ...current, thinkingLevel: 'high' }
          return Promise.resolve({})
        }
        return undefined
      }
    })
    await openAt8(h, acquired.acquisitionGeneration)
    await h.adapter.dispatch({
      sessionId,
      fence: 8,
      clientMessageId: 'switch',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      executionOptions: { model: 'anthropic/model-2', effort: 'high' }
    })
    listing.resolve({ models: [state.model, current.model] })
    await vi.waitFor(() =>
      expect(reportedEvent(h.lifecycle, 'options-reported')).toMatchObject({
        reportedOptions: { model: 'anthropic/model-2', effort: 'high' },
        catalogListing: { configuredDefault: { modelId: 'anthropic/model-1', effort: 'low' } }
      })
    )
    expect(child.sent).toMatchObject([{ type: 'prompt', message: 'go' }])
  })

  it('teaches the account default only from a new session started with no pick', async () => {
    const h = await setup()
    await vi.waitFor(() =>
      expect(
        reportedEvent(h.lifecycle, 'options-reported').catalogListing?.configuredDefault
      ).toEqual({ modelId: 'anthropic/model-1', effort: null })
    )

    h.resolveLaunch.mockResolvedValueOnce({ ...(await h.resolveLaunch()), sessionFile: file })
    const { acquired } = await restart(h, () => {})
    await openAt8(h, acquired.acquisitionGeneration)
    await vi.waitFor(() =>
      expect(reportedEvent(h.lifecycle, 'options-reported').catalogListing).toBeDefined()
    )
    expect(reportedEvent(h.lifecycle, 'options-reported').catalogListing).not.toHaveProperty(
      'configuredDefault'
    )
  })
})

it('keeps native idle reports off current and action progress and rejects pre-control state', async () => {
  const h = await setup()
  await vi.waitFor(() => expect(h.adapter.readCommands(sessionId)).toBeDefined())
  const held = Promise.withResolvers<unknown>()
  const entered = vi.fn()
  h.connection.requestOverride = (command) => {
    if (command === 'get_state') {
      entered()
      return held.promise
    }
    return undefined
  }
  try {
    const send = (id: string) =>
      h.adapter.dispatch({
        sessionId,
        fence: 7,
        clientMessageId: id,
        executionOptions: {},
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
      })
    await send('first')
    h.connection.handlers.onRecord?.({ type: 'agent_start' })
    h.connection.handlers.onRecord?.({ type: 'agent_settled' })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    expect((await h.adapter.readOptions({ sessionId, fence: 7 })).current.model).toBe(
      'anthropic/model-1'
    )
    await h.adapter.setOption({ sessionId, fence: 7, key: 'model', value: 'anthropic/model-2' })
    expect((await h.adapter.cancelTurn({ sessionId, fence: 7 })).cancelled).toBe(true)
    held.resolve({ ...state, thinkingLevel: 'high' })
    await Promise.resolve()
    await Promise.resolve()
    expect((await h.adapter.readOptions({ sessionId, fence: 7 })).current.model).toBe(
      'anthropic/model-2'
    )
    h.connection.requestOverride = (command) =>
      command === 'get_state'
        ? Promise.resolve({
            ...state,
            model: { provider: 'anthropic', id: 'native-3' },
            thinkingLevel: 'low'
          })
        : undefined
    await send('later')
    h.connection.handlers.onRecord?.({ type: 'agent_start' })
    h.connection.handlers.onRecord?.({ type: 'agent_settled' })
    await vi.waitFor(async () =>
      expect((await h.adapter.readOptions({ sessionId, fence: 7 })).current).toMatchObject({
        model: 'anthropic/native-3',
        effort: 'low'
      })
    )
    await send('during-control')
    h.connection.handlers.onRecord?.({ type: 'agent_start' })
    const control = Promise.withResolvers<unknown>()
    h.connection.requestOverride = (command) =>
      command === 'set_model'
        ? control.promise
        : command === 'get_state'
          ? Promise.resolve(state)
          : undefined
    const writing = h.adapter.setOption({
      sessionId,
      fence: 7,
      key: 'model',
      value: 'anthropic/model-4'
    })
    h.connection.handlers.onRecord?.({ type: 'agent_settled' })
    await vi.waitFor(async () =>
      expect((await h.adapter.readOptions({ sessionId, fence: 7 })).current.model).toBeUndefined()
    )
    control.resolve({})
    await writing
    const after = await h.adapter.readOptions({ sessionId, fence: 7 })
    expect(after.current.model).toBe('anthropic/model-4')
    expect(after.current.confirmed).not.toContain('model')
  } finally {
    held.resolve(state)
  }
})
