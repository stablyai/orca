import { expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import { MobileTerminalInputSender } from './mobile-terminal-input-sender'
import { buildTerminalSendParams } from './terminal-send-request'
import { terminalInputSend } from './mobile-terminal-operations'
import {
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  queueTerminalLiveControlSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../src/shared/terminal/input/terminal-input'

const accepted: RpcResponse = { id: 'send', ok: true, result: { send: { accepted: true } } }
const opened: RpcResponse = { id: 'open', ok: true, result: { inputSessionId: 'session' } }
const params = (text: string, terminal = 'term') =>
  buildTerminalSendParams({ terminal, text, enter: false, deviceToken: 'phone' })

function transport(holdOpen = false) {
  const sent: unknown[] = []
  const releases: ((reply: RpcResponse) => void)[] = []
  let open = (_reply: RpcResponse): void => {}
  let generation = 1
  const client = stubRpcClient({
    getGeneration: () => generation,
    sendRequest: vi.fn((method, payload, options) => {
      options?.beforeSend?.()
      sent.push({ method, payload })
      if (method === 'terminal.openInputSession') {
        return holdOpen
          ? new Promise<RpcResponse>((resolve) => {
              open = resolve
            })
          : Promise.resolve(opened)
      }
      return new Promise<RpcResponse>((resolve) => releases.push(resolve))
    })
  })
  return {
    client,
    sent,
    releases,
    open: () => open(opened),
    cutover: () => {
      generation += 1
    }
  }
}

it('admits live text and controls into a bounded window before any send reply, preserving the delivery barrier', async () => {
  const wire = transport()
  const sender = new MobileTerminalInputSender()
  const state = createTerminalLivePendingFlushState()
  const send = (
    handle: string,
    text: string,
    enqueue?: Parameters<MobileTerminalInputSender['request']>[4]
  ) =>
    sender
      .request(wire.client, params(text, handle), undefined, true, enqueue)
      .then((reply) => terminalInputSend.interpret(reply) === true)
  const deliveries = [queueTerminalLiveMirrorSend(state, 'term', 'a', send)]
  await vi.waitFor(() => expect(wire.releases).toHaveLength(1))
  deliveries.push(
    ...Array.from('bcdefgh', (text) => queueTerminalLiveMirrorSend(state, 'term', text, send))
  )
  deliveries.push(queueTerminalLiveControlSend(state, 'term', '\r', send))
  let settled = false
  void waitForTerminalLivePendingFlush(state).then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(wire.releases).toHaveLength(8))
  expect(wire.sent).toEqual([
    {
      method: 'terminal.openInputSession',
      payload: { terminal: 'term', client: { id: 'phone', type: 'mobile' } }
    },
    ...Array.from('abcdefgh', (text, index) => ({
      method: 'terminal.send',
      payload: { ...params(text), inputSequence: { sessionId: 'session', seq: index + 1 } }
    }))
  ])
  expect(settled).toBe(false)
  wire.releases.splice(0).forEach((release) => release(accepted))
  await vi.waitFor(() => expect(wire.releases).toHaveLength(1))
  expect(wire.sent.at(-1)).toEqual({
    method: 'terminal.send',
    payload: { ...params('\r'), inputSequence: { sessionId: 'session', seq: 9 } }
  })
  wire.releases.shift()!(accepted)
  await expect(Promise.all(deliveries)).resolves.toEqual(Array(9).fill(true))
})

it('keeps issued byte reservations after cancellation until physical settlement and accepts a legal buffered paste', async () => {
  const wire = transport()
  const sender = new MobileTerminalInputSender()
  const controller = new AbortController()
  const paste = sender.request(
    wire.client,
    params('x'.repeat(TERMINAL_INPUT_MAX_BYTES)),
    undefined,
    true,
    { signal: controller.signal }
  )
  await vi.waitFor(() => expect(wire.releases).toHaveLength(1))
  controller.abort()
  expect(terminalInputSend.interpret(await paste)).toBe(false)
  const blocked = await sender.request(
    wire.client,
    params('y'.repeat(2 * 1024 * 1024), 'other'),
    undefined,
    true
  )
  expect(terminalInputSend.interpret(blocked)).toBe(false)
  wire.releases.shift()!(accepted)
  await Promise.resolve()
  await Promise.resolve()
  const next = sender.request(wire.client, params('z'), undefined, true)
  await vi.waitFor(() => expect(wire.releases).toHaveLength(1))
  wire.releases.shift()!(accepted)
  expect(terminalInputSend.interpret(await next)).toBe(true)
})

it('drops a queued suffix on an unknown result and never replays it after cutover', async () => {
  const wire = transport()
  const sender = new MobileTerminalInputSender()
  const deliveries = [sender.request(wire.client, params('x'), undefined, true)]
  await vi.waitFor(() => expect(wire.releases).toHaveLength(1))
  deliveries.push(
    ...Array.from({ length: 11 }, () => sender.request(wire.client, params('x'), undefined, true))
  )
  await vi.waitFor(() => expect(wire.releases).toHaveLength(8))
  wire.releases.shift()!({ id: 'lost', ok: false, error: { code: 'lost', message: 'lost' } })
  await Promise.all(deliveries)
  wire.cutover()
  const fresh = sender.request(wire.client, params('fresh'), undefined, true)
  expect(wire.sent.filter((entry) => JSON.stringify(entry).includes('fresh'))).toHaveLength(0)
  wire.releases.splice(0).forEach((release) => release(accepted))
  await vi.waitFor(() => expect(wire.releases).toHaveLength(1))
  wire.releases.shift()!(accepted)
  expect(terminalInputSend.interpret(await fresh)).toBe(true)
})
