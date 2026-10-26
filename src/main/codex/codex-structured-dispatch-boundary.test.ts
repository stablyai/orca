import { expect, it, vi } from 'vitest'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import {
  type LateSettlement,
  acquiredCodexAdapter,
  CODEX_TEST_USER_MESSAGE,
  startTurn,
  echoUserMessage,
  refuseUnroutedSteer,
  fakeCodexAppServer
} from './codex-structured-dispatch-test-support'

it('checks continuation authority before writing turn/start', async () => {
  const codex = fakeCodexAppServer()
  const adapter = await acquiredCodexAdapter({ codex, settlements: [] })
  const beforeDispatch = vi.fn(async () => {
    throw new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  })
  try {
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'continuation',
        body: CODEX_TEST_USER_MESSAGE,
        fence: 7,
        beforeDispatch
      })
    ).rejects.toBeInstanceOf(AgentSessionPreDispatchError)
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/start')).toBe(false)
  } finally {
    await adapter.closeAll()
  }
})

it('stops a refused steer before its fallback write', async () => {
  const refused = Promise.withResolvers<unknown>()
  const codex = fakeCodexAppServer({ 'turn/steer': () => refused.promise })
  const settlements: LateSettlement[] = []
  const adapter = await acquiredCodexAdapter({ codex, settlements })
  const connection = codex.connections[0]!
  startTurn(connection, 'running')
  const controller = new AbortController()
  const reason = new Error('Stopped before fallback')
  const send = (id: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      fence: 7,
      body: CODEX_TEST_USER_MESSAGE,
      signal: controller.signal
    })
  const sending = send('stopped')
  await vi.waitFor(() =>
    expect(connection.calls.some((call) => call.method === 'turn/steer')).toBe(true)
  )
  controller.abort(reason)
  try {
    refuseUnroutedSteer(undefined)
  } catch (error) {
    refused.reject(error)
  }
  await expect(sending).rejects.toBe(reason)
  expect(connection.calls.some((call) => call.method === 'turn/start')).toBe(false)
  // The journal keeps stopped sends rejected even if an exact echo arrives.
  echoUserMessage(connection, { turnId: 'running', itemId: 'stopped', clientId: 'stopped' })
  expect(settlements.map((entry) => entry.clientMessageId)).toEqual(['stopped'])
  await adapter.closeAll()
})

it('abandons only the stopped message while waiting for a previous turn to open', async () => {
  const codex = fakeCodexAppServer({ 'turn/start': () => ({ turn: { id: 'opening' } }) })
  const settlements: LateSettlement[] = []
  const adapter = await acquiredCodexAdapter({ codex, settlements })
  const connection = codex.connections[0]!
  const dispatch = (id: string, signal?: AbortSignal) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      fence: 7,
      body: CODEX_TEST_USER_MESSAGE,
      signal
    })
  await expect(dispatch('first')).resolves.toMatchObject({ state: 'admitted' })
  const controller = new AbortController()
  const stopped = dispatch('waiting', controller.signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  const reason = new Error('Stopped local wait')
  controller.abort(reason)
  await expect(stopped).rejects.toBe(reason)
  expect(connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  startTurn(connection, 'opening')
  echoUserMessage(connection, { turnId: 'opening', itemId: 'first', clientId: 'first' })
  expect(settlements.map((entry) => entry.clientMessageId)).toEqual(['first'])
  await adapter.closeAll()
})

it.each(['accepted', 'uncertain'] as const)(
  'retains the %s outcome of a steer written before Stop',
  async (outcome) => {
    const answer = Promise.withResolvers<unknown>()
    const codex = fakeCodexAppServer({ 'turn/steer': () => answer.promise })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'running')
    const controller = new AbortController()
    const sent = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'written',
      fence: 7,
      body: CODEX_TEST_USER_MESSAGE,
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(connection.calls.some((call) => call.method === 'turn/steer')).toBe(true)
    )
    controller.abort(new Error('Stop after write'))
    if (outcome === 'accepted') {
      answer.resolve({ turnId: 'running' })
      await expect(sent).resolves.toMatchObject({ state: 'admitted' })
    } else {
      const lost = new Error('Reply lost after write')
      answer.reject(lost)
      await expect(sent).rejects.toBe(lost)
    }
    echoUserMessage(connection, { turnId: 'running', itemId: 'written', clientId: 'written' })
    expect(settlements.map((entry) => entry.clientMessageId)).toEqual(['written'])
    await adapter.closeAll()
  }
)
