import { afterEach, expect, it, vi } from 'vitest'
import {
  acquired,
  answerWithOpenedTurn,
  fakeCodex,
  THREAD_ID,
  USER_MESSAGE
} from './codex-structured-session-adapter-fixture'

afterEach(() => vi.useRealTimers())

it('lets a Stop wait for the interrupted turn to end, without waiting on its missing echo', async () => {
  const codex = fakeCodex()
  codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
  const adapter = await acquired(codex)
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'first',
    fence: 7,
    body: USER_MESSAGE
  })
  await adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })
  let ended = false
  const waiting = adapter.awaitStoppedRequestEnd('session-1', Date.now()).then(() => {
    ended = true
  })
  await Promise.resolve()
  expect(ended).toBe(false)
  codex.connections[0].handlers.onNotification?.('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: 'turn-1', status: 'interrupted' }
  })
  await waiting
  expect(ended).toBe(true)
  await adapter.closeAll()
})

it('spends only the remaining two-second budget from the Stop timestamp', async () => {
  const codex = fakeCodex()
  codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
  const adapter = await acquired(codex)
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'first',
    fence: 7,
    body: USER_MESSAGE
  })
  vi.useFakeTimers()
  const stoppedAt = Date.now() - 500
  let ended = false
  const waiting = adapter.awaitStoppedRequestEnd('session-1', stoppedAt).then(() => {
    ended = true
  })
  await vi.advanceTimersByTimeAsync(1_499)
  expect(ended).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await waiting
  expect(ended).toBe(true)
  vi.useRealTimers()
  await adapter.closeAll()
})

it('waits for a dispatch that is still unanswered, then wakes when the child exits', async () => {
  const gate = Promise.withResolvers<unknown>()
  const codex = fakeCodex({ 'turn/start': () => gate.promise })
  const adapter = await acquired(codex)
  const dispatching = adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'first',
    fence: 7,
    body: USER_MESSAGE
  })
  let ended = false
  const waiting = adapter.awaitStoppedRequestEnd('session-1', Date.now()).then(() => {
    ended = true
  })
  await Promise.resolve()
  expect(ended).toBe(false)
  await adapter.closeSession('session-1')
  await waiting
  gate.resolve({})
  await dispatching
  expect(ended).toBe(true)
})

it('resolves at once when there is no live request or child', async () => {
  const adapter = await acquired(fakeCodex())
  await adapter.awaitStoppedRequestEnd('session-1', Date.now())
  await adapter.awaitStoppedRequestEnd('absent', Date.now())
  await adapter.closeAll()
})
