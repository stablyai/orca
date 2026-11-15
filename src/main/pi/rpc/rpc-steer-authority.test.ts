import { afterEach, expect, it, vi } from 'vitest'
import { closePiRpcAdapterFixtures, sessionId, setup } from './rpc-session-adapter.test-fixture'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { Writable } from 'node:stream'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { JsonlRpcAgentConnection } from '../../jsonl-rpc/agent-connection'

function realStdin(h: Awaited<ReturnType<typeof setup>>) {
  const child = createFakePipedChild()
  const written: string[] = []
  const queued = Promise.withResolvers<void>()
  let release = (): void => {}
  Object.assign(child, {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(chunk.toString())
        written.push(frame.message ?? frame.type)
        if (frame.type === 'blocked-control') {
          release = () => {
            release = () => {}
            callback()
          }
        } else {
          callback()
        }
      }
    })
  })
  const transport = new JsonlRpcAgentConnection(
    { command: 'fixture-pi', args: [] },
    {},
    () => child
  )
  vi.spyOn(h.connection, 'send').mockImplementation((frame, assertWritable) => {
    const sent = transport.send(frame, assertWritable)
    if (frame.message === 'A') {
      queued.resolve()
    }
    return sent
  })
  return {
    transport,
    written,
    queued: queued.promise,
    release: () => release(),
    close: async () => {
      release()
      child.emit('exit', 0, null)
      child.stdout.end()
      await transport.close()
    }
  }
}

it('drops an expired prompt in the real stdin queue without closing the active write or delaying B', async () => {
  const h = await setup()
  const wire = realStdin(h)
  let current = true
  const active = wire.transport.send({ type: 'blocked-control' })
  try {
    const a = h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'A',
      body: message('A'),
      isCurrent: () => current
    })
    const rejected = expect(a).rejects.toMatchObject({
      outcome: { state: 'rejected', rejection: { kind: 'writeFailed', neverReachedAgent: true } }
    })
    await wire.queued
    current = false
    const b = h.adapter.dispatch({ sessionId, fence: 7, clientMessageId: 'B', body: message('B') })
    wire.release()
    await active
    await rejected
    expect(await b).toMatchObject({ state: 'admitted' })
    expect(wire.written).toEqual(['blocked-control', 'B'])
    expect(wire.transport.closed).toBe(false)
  } finally {
    await wire.close()
  }
})

it('settles a queued auth retry as unwritten when authority expires before stdin drains', async () => {
  const h = await setup()
  const wire = realStdin(h)
  let current = true
  try {
    await h.adapter.dispatch({
      sessionId,
      fence: 7,
      clientMessageId: 'A',
      body: message('A'),
      isCurrent: () => current
    })
    const active = wire.transport.send({ type: 'blocked-control' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.connection.receive({
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'No API key found for provider'
    })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()
    current = false
    const b = h.adapter.dispatch({ sessionId, fence: 7, clientMessageId: 'B', body: message('B') })
    wire.release()
    await active
    expect(await b).toMatchObject({ state: 'admitted' })
    expect(wire.written).toEqual(['A', 'blocked-control', 'B'])
    expect(wire.transport.closed).toBe(false)
    expect(h.settled.mock.calls.map(([outcome]) => outcome)).toContainEqual(
      expect.objectContaining({
        clientMessageId: 'A',
        outcome: expect.objectContaining({
          state: 'rejected',
          rejection: expect.objectContaining({ kind: 'notSignedIn', neverReachedAgent: true })
        })
      })
    )
  } finally {
    await wire.close()
  }
})

afterEach(async () => {
  vi.useRealTimers()
  await closePiRpcAdapterFixtures()
})

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

it('does not write an expired steer after asynchronous preparation resumes', async () => {
  const h = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let current = true
  const a = h.adapter.dispatch({
    sessionId,
    fence: 7,
    clientMessageId: 'A',
    body: message('A'),
    isCurrent: () => current,
    beforeDispatch: async () => {
      entered.resolve()
      await release.promise
    }
  })
  await entered.promise
  current = false
  await h.adapter.dispatch({ sessionId, fence: 7, clientMessageId: 'B', body: message('B') })
  release.resolve()
  await expect(a).rejects.toMatchObject({
    outcome: { state: 'rejected', rejection: { kind: 'writeFailed', neverReachedAgent: true } }
  })
  expect(h.connection.sent.map((frame) => frame.message)).toEqual(['B'])
})

it('settles an auth refusal instead of retrying a steer whose write authority expired', async () => {
  const h = await setup()
  const expiry = new AbortController()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await h.adapter.dispatch({
    sessionId,
    fence: 7,
    clientMessageId: 'A',
    body: message('A'),
    signal: expiry.signal
  })
  h.connection.receive({
    type: 'response',
    command: 'prompt',
    success: false,
    error: 'No API key found for provider'
  })
  expiry.abort(new Error('steer expired'))
  await h.adapter.dispatch({ sessionId, fence: 7, clientMessageId: 'B', body: message('B') })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(h.connection.sent.map((frame) => frame.message)).toEqual(['A', 'B'])
  expect(h.settled.mock.calls.map(([outcome]) => outcome)).toContainEqual(
    expect.objectContaining({
      clientMessageId: 'A',
      outcome: expect.objectContaining({
        state: 'rejected',
        rejection: expect.objectContaining({ kind: 'notSignedIn', neverReachedAgent: true })
      })
    })
  )
})
