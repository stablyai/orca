import { afterEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { encodeJsonRpcFrame, HEADER_LENGTH } from './relay-protocol'
import type { MultiplexerTransportWriteResult } from './ssh-multiplexer-transport-writer'

const multiplexers: SshChannelMultiplexer[] = []
afterEach(() => {
  for (const mux of multiplexers.splice(0)) {
    mux.dispose()
  }
})

function fixture() {
  const writes: Buffer[] = []
  const settlements: ((result: MultiplexerTransportWriteResult) => void)[] = []
  let receive = (_data: Buffer): void => {}
  let sequence = 0
  const mux = new SshChannelMultiplexer({
    supportsWriteSettlement: true,
    write: (data, settled) => {
      writes.push(data)
      settlements.push(settled!)
      return true
    },
    onData: (callback) => {
      receive = callback
    },
    onClose: () => {}
  })
  multiplexers.push(mux)
  return {
    mux,
    writes,
    settlements,
    request: (method = 'orca.cli') => {
      const id = ++sequence
      receive(
        encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params: { argv: ['status'] } }, id, 0)
      )
    },
    response: (index = 0) => JSON.parse(writes[index].subarray(HEADER_LENGTH).toString()),
    drain: (signal = new AbortController().signal) => mux.waitForRelayResetDrain(signal)
  }
}

it('waits for the captured incoming handler AND its later response write', async () => {
  const f = fixture()
  const work = Promise.withResolvers<string>()
  f.mux.onRequest('orca.cli', () => work.promise)
  f.request()
  f.mux.fenceForRelayReset()
  const completed = vi.fn()
  const draining = f.drain().then(completed)
  await Promise.resolve()
  expect(completed).not.toHaveBeenCalled()
  work.resolve('done')
  await vi.waitFor(() => expect(f.writes).toHaveLength(1))
  expect(f.response().result).toBe('done')
  expect(completed).not.toHaveBeenCalled()
  f.settlements[0]({ ok: true })
  await draining
  expect(completed).toHaveBeenCalledOnce()
})

it.each(['orca.cli', 'orca.cli.postOutput', 'relay.status', 'unknown.method'])(
  'refuses new incoming %s after the fence without invoking handlers',
  async (method) => {
    const f = fixture()
    const handler = vi.fn(() => 'unexpected')
    f.mux.onRequest(method, handler)
    f.mux.fenceForRelayReset()
    f.request(method)
    expect(handler).not.toHaveBeenCalled()
    expect(f.response().error).toEqual({
      code: -32000,
      message: 'relay_reset_work_admission_closed'
    })
    f.settlements[0]({ ok: true })
    await f.drain()
  }
)

it('ordinary migration drains do not wait on the CLI handler invoking them', async () => {
  const f = fixture()
  f.mux.onRequest('orca.cli', async () => {
    await f.mux.waitForPendingOperations(new AbortController().signal)
    return 'ordinary drain done'
  })
  f.request()
  await vi.waitFor(() => expect(f.writes).toHaveLength(1))
  expect(f.response().result).toBe('ordinary drain done')
  f.settlements[0]({ ok: true })
})

it('retains a handler failure that settled between fencing and the first reset observation', async () => {
  const f = fixture()
  const work = Promise.withResolvers<void>()
  f.mux.onRequest('orca.cli', () => work.promise)
  f.request()
  f.mux.fenceForRelayReset()
  work.reject(new Error('work uncertain'))
  await vi.waitFor(() => expect(f.writes).toHaveLength(1))
  f.settlements[0]({ ok: true })
  await expect(f.drain()).rejects.toThrow('work uncertain')
  await expect(f.drain()).rejects.toThrow('work uncertain')
})

it('retains response-write uncertainty instead of reporting an empty successful retry', async () => {
  const f = fixture()
  f.mux.onRequest('orca.cli', () => 'done')
  f.request()
  f.mux.fenceForRelayReset()
  await vi.waitFor(() => expect(f.writes).toHaveLength(1))
  const draining = expect(f.drain()).rejects.toThrow()
  f.settlements[0]({ ok: false, error: new Error('response write lost') })
  await draining
  await expect(f.drain()).rejects.toThrow()
})

it('aborts observation without releasing the fence or discarding pending inbound work', async () => {
  const f = fixture()
  const work = Promise.withResolvers<string>()
  const handler = vi.fn(() => work.promise)
  f.mux.onRequest('orca.cli', handler)
  f.request()
  f.mux.fenceForRelayReset()
  const controller = new AbortController()
  const draining = f.drain(controller.signal)
  controller.abort(new Error('stop observing'))
  await expect(draining).rejects.toThrow('stop observing')
  work.resolve('done')
  await vi.waitFor(() => expect(f.writes).toHaveLength(1))
  f.settlements[0]({ ok: true })
  await f.drain()
  f.request()
  expect(handler).toHaveBeenCalledOnce()
  expect(f.response(1).error.message).toBe('relay_reset_work_admission_closed')
})

it('preserves serialization-error replies and refuses to call that successful reset drain', async () => {
  const f = fixture()
  f.mux.onRequest('orca.cli', () => 1n)
  f.request()
  f.mux.fenceForRelayReset()
  await vi.waitFor(() => expect(f.writes).toHaveLength(1))
  expect(f.response().error.message).toMatch(/BigInt/i)
  f.settlements[0]({ ok: true })
  await expect(f.drain()).rejects.toThrow(/BigInt/i)
})

it('refuses reset observation before fencing and on disposal during an active handler', async () => {
  const f = fixture()
  await expect(f.drain()).rejects.toThrow('admission_not_closed')
  const work = Promise.withResolvers<void>()
  f.mux.onRequest('orca.cli', () => work.promise)
  f.request()
  f.mux.fenceForRelayReset()
  const draining = expect(f.drain()).rejects.toThrow()
  f.mux.dispose('connection_lost')
  await draining
  work.resolve()
})
