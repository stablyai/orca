import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { JsonlRpcPeer, JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closePiRpcAdapterFixtures,
  type FakeConnection,
  restart,
  sessionId,
  setup
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
  const peer = new JsonlRpcPeer(input, output, {
    onClose: (error) => connection.handlers.onClose?.(error)
  })
  let requestId: string
  output.on('data', (chunk) => {
    requestId = JSON.parse(String(chunk)).id
  })
  const request = connection.request.bind(connection)
  connection.request = (command, params, options?: Parameters<JsonlRpcPeer['request']>[2]) =>
    command === 'get_state' ? peer.request(command, params, options) : request(command, params)
  connection.abortRequest = () => peer.close()
  return Object.assign(
    () => input.write(`${JSON.stringify({ ...recordedState, id: requestId })}\n`),
    {
      refuseAfterWriteFailure: () => {
        output.emit('error', Object.assign(new Error('Pi stdin ended'), { code: 'EPIPE' }))
        input.write(
          `${JSON.stringify({ type: 'response', id: requestId, command: 'get_state', success: false, error: 'Pi refused its state' })}\n`
        )
      }
    }
  )
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
    let refuse = false
    const h = await setup({}, (sink) => ({
      ...sink,
      tryAppendTransition: (transition) =>
        refuse ? { accepted: false, reason: 'failed' } : sink.tryAppendTransition!(transition)
    }))
    let reply!: () => unknown
    const { acquired, child } = await restart(h, (connection) => {
      reply = stateThroughPeer(connection)
    })
    const opening = openAt8(h, acquired.acquisitionGeneration)
    refuse = true
    child.receive({
      type: 'extension_ui_request',
      id: 'startup-confirm',
      method: 'confirm',
      title: 'Continue?',
      message: 'Ready?'
    })
    await expect(opening).rejects.toMatchObject({ message: 'failed', retry: 'never' })
    refuse = false
    reply()
    await expect(openAt8(h, acquired.acquisitionGeneration)).rejects.toThrow('failed')
    await expect(
      h.adapter.dispatch({
        sessionId,
        fence: 8,
        clientMessageId: 'failed-start',
        executionOptions: {},
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
      })
    ).rejects.toThrow('Pi session is not live')
    expect(child.sent).not.toContainEqual(expect.objectContaining({ type: 'prompt' }))
  })

  it('keeps a native refusal received before the write-side failure closes the peer', async () => {
    const h = await setup()
    let reply!: ReturnType<typeof stateThroughPeer>
    const { acquired } = await restart(h, (connection) => {
      reply = stateThroughPeer(connection)
    })
    const opening = openAt8(h, acquired.acquisitionGeneration).catch((error: unknown) => error)
    reply.refuseAfterWriteFailure()
    const failure = await opening
    expect(failure).toMatchObject({ message: 'Pi refused its state', retry: 'never' })
    expect(failure.cause).toBeInstanceOf(JsonlRpcResponseError)
  })
})
