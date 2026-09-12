import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { encodeJsonRpcFrame, HEADER_LENGTH } from './relay-protocol'
import type { MultiplexerTransportWriteResult } from './ssh-multiplexer-transport-writer'
import { SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD } from '../../shared/skill-ssh-relay-contract'

const requestMethods = [
  'relay.status',
  'relay.reset',
  'relay.recoverPreparedReset',
  'fs.unwatchAndWait',
  'agent.cancelExec',
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD
]
const notificationMethods = [
  'rpc.cancel',
  'git.responseAck',
  'git.cancelResponseStream',
  'fs.streamAck',
  'fs.cancelStream',
  'fs.unwatch',
  'pty.ackData',
  'pty.setDeliveryPaused'
]
const multiplexers: SshChannelMultiplexer[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const mux of multiplexers.splice(0)) {
    mux.dispose()
  }
  vi.useRealTimers()
})
function fixture() {
  const written: Buffer[] = []
  const settlements: ((result: MultiplexerTransportWriteResult) => void)[] = []
  let receive: (data: Buffer) => void = () => {}
  const mux = new SshChannelMultiplexer({
    supportsWriteSettlement: true,
    write: (data, settled) => {
      written.push(data)
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
    written,
    settlements,
    respond(index: number, result: unknown = null) {
      const request = JSON.parse(written[index].subarray(HEADER_LENGTH).toString())
      receive(encodeJsonRpcFrame({ jsonrpc: '2.0', id: request.id, result }, request.id, 0))
    }
  }
}

it('drains pre-fence requests through both response and write settlement', async () => {
  const f = fixture()
  const pending = f.mux.request('fs.writeFile', { path: '/before', content: 'text' })
  f.mux.fenceForRelayReset()
  const done = vi.fn()
  const drain = f.mux.waitForPendingOperations(new AbortController().signal).then(done)
  await expect(f.mux.request('fs.writeFile', {})).rejects.toThrow('admission_closed')
  f.respond(0)
  await pending
  expect(done).not.toHaveBeenCalled()
  f.settlements[0]({ ok: true })
  await drain
  expect(done).toHaveBeenCalledOnce()
  expect(f.written).toHaveLength(1)
})

it.each([
  'pty.spawn',
  'pty.openClient',
  'pty.data',
  'pty.shutdown',
  'fs.writeFile',
  'git.fetch',
  'agent.exec',
  'relay.unknown',
  'relay.reset.extra',
  'unknown'
])('refuses ordinary or unknown %s through every publication API', async (method) => {
  const f = fixture()
  f.mux.fenceForRelayReset()
  f.mux.fenceForRelayReset()
  await expect(f.mux.request(method, { id: 'terminal' })).rejects.toThrow('admission_closed')
  expect(() => f.mux.notify(method, { id: 'terminal' })).toThrow('admission_closed')
  const settled = vi.fn()
  f.mux.notifyWithSettlement(method, { id: 'terminal' }, settled)
  expect(settled).toHaveBeenCalledOnce()
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: 'refused',
      reason: 'write_gate_denied'
    })
  )
  expect(f.written).toHaveLength(0)
  expect(f.mux.isDisposed()).toBe(false)
})

it.each(requestMethods)('allows only request framing for drain request %s', async (method) => {
  const f = fixture()
  f.mux.fenceForRelayReset()
  const request = f.mux.request(method, {})
  f.respond(0)
  f.settlements[0]({ ok: true })
  await request
  expect(() => f.mux.notify(method, {})).toThrow('admission_closed')
  const settled = vi.fn()
  f.mux.notifyWithSettlement(method, {}, settled)
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }))
  expect(f.written).toHaveLength(1)
})

it.each(notificationMethods)(
  'allows only notification framing for drain notification %s',
  async (method) => {
    const f = fixture()
    f.mux.fenceForRelayReset()
    f.mux.notify(method, {})
    const settled = vi.fn()
    f.mux.notifyWithSettlement(method, {}, settled)
    expect(settled).not.toHaveBeenCalled()
    f.settlements[1]({ ok: true })
    expect(settled).toHaveBeenCalledWith({ outcome: 'accepted' })
    await expect(f.mux.request(method, {})).rejects.toThrow('admission_closed')
    expect(f.written).toHaveLength(2)
  }
)

it('allows cancellation of earlier work and keeps the fence after a failed drain', async () => {
  const f = fixture()
  const controller = new AbortController()
  const request = f.mux
    .request('agent.exec', {}, { signal: controller.signal })
    .catch((error) => error)
  f.settlements[0]({ ok: true })
  f.mux.fenceForRelayReset()
  const drain = f.mux.waitForPendingOperations(new AbortController().signal).catch((error) => error)
  controller.abort()
  expect(await request).toMatchObject({ name: 'AbortError' })
  expect(await drain).toMatchObject({ name: 'AbortError' })
  expect(JSON.parse(f.written[1].subarray(HEADER_LENGTH).toString()).method).toBe('rpc.cancel')
  await expect(f.mux.request('agent.exec', {})).rejects.toThrow('admission_closed')
})

it('does not fence another or replacement mux', async () => {
  const old = fixture()
  old.mux.fenceForRelayReset()
  const replacement = fixture()
  const request = replacement.mux.request('pty.spawn', {})
  replacement.respond(0, { id: 'new' })
  replacement.settlements[0]({ ok: true })
  await expect(request).resolves.toEqual({ id: 'new' })
  expect(old.written).toHaveLength(0)
})
