import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { JsonlRpcPeer } from '../jsonl-rpc/peer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  type FakeConnection,
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

const recordedState = readFileSync(
  new URL('./__fixtures__/command-only.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(JSON.parse(line).raw))
  .find((frame) => frame.type === 'response' && frame.command === 'get_state')

function stateThroughPeer(connection: FakeConnection) {
  const input = new PassThrough()
  const output = new PassThrough()
  const peer = new JsonlRpcPeer(input, output)
  let requestId: string
  output.on('data', (chunk) => {
    requestId = JSON.parse(String(chunk)).id
  })
  const request = connection.request.bind(connection)
  connection.request = (command, params, options?: Parameters<JsonlRpcPeer['request']>[2]) =>
    command === 'get_state' ? peer.request(command, params, options) : request(command, params)
  connection.abortRequest = () => peer.close()
  return () => input.write(`${JSON.stringify({ ...recordedState, id: requestId })}\n`)
}

afterEach(async () => {
  await closePiRpcAdapterFixtures()
  vi.useRealTimers()
})

describe('Pi host awaited open', () => {
  it('opens on Pi state received after the transport default would expire', async () => {
    const h = await setup()
    vi.useFakeTimers()
    let reply!: () => unknown
    const { acquired, child } = await restart(h, (connection) => {
      reply = stateThroughPeer(connection)
    })
    const opened = expect(openAt8(h, acquired.acquisitionGeneration)).resolves.toMatchObject({
      reportedOptions: { model: 'openai-codex/gpt-6.1-sol', effort: 'medium' }
    })
    await vi.advanceTimersByTimeAsync(31_000)
    reply()
    await opened
    await h.adapter.dispatch({
      sessionId,
      fence: 8,
      clientMessageId: 'slow-start',
      executionOptions: {},
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    })
    expect(child.sent).toMatchObject([{ type: 'prompt', message: 'hello' }])
  })

  it('lets the host close a child held in the state request without a late open', async () => {
    const h = await setup()
    let reply!: () => unknown
    const { acquired, child } = await restart(h, (connection) => {
      reply = stateThroughPeer(connection)
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
    controller.abort()
    await h.adapter.closeSession(sessionId)
    expect(await opening).toBeInstanceOf(Error)
    reply()
    await Promise.resolve()
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
})
