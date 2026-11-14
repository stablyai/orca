import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { JsonlRpcPeer } from '../../jsonl-rpc/peer'
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
  it('retains a recorded pending dialog when its provider process closes', async () => {
    const h = await setup()
    const dialog = readFileSync(new URL('./__fixtures__/dialogs.jsonl', import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(JSON.parse(line).raw))
      .find((frame) => frame.type === 'extension_ui_request' && frame.method === 'confirm')
    expect(dialog).toBeDefined()
    h.connection.receive(dialog)
    await vi.waitFor(async () =>
      expect(await h.rig.rows()).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            kind: 'approval',
            resolution: expect.objectContaining({ state: 'pending' })
          })
        })
      )
    )
    expect(await h.adapter.closeSession(sessionId)).toBe(true)
    await h.adapter.drainObservedExits()
    expect(await h.rig.rows()).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'approval',
          resolution: expect.objectContaining({ state: 'pending' })
        })
      })
    )
    expect(h.connection.sent).not.toContainEqual(
      expect.objectContaining({ type: 'extension_ui_response', cancelled: true })
    )
  })

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
})
