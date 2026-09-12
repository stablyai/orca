import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { encodeJsonRpcFrame, HEADER_LENGTH } from './relay-protocol'
import {
  SshMultiplexerTransportWriter,
  type MultiplexerTransport,
  type MultiplexerTransportWriteResult
} from './ssh-multiplexer-transport-writer'

const profile = vi.hoisted(() => ({ assertCurrent: vi.fn<() => void>() }))
vi.mock('./profile-lifetime-admission', () => ({
  assertProfileLifetimeAdmission: profile.assertCurrent
}))

const cleanups: (() => void)[] = []
beforeEach(() => vi.resetAllMocks())
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  vi.useRealTimers()
})

function fixture(writeResults: boolean[] = []) {
  const writes: Buffer[] = []
  const settlements: ((result: MultiplexerTransportWriteResult) => void)[] = []
  const close = vi.fn()
  const removeDrain = vi.fn()
  let receive: (data: Buffer) => void = () => {}
  let drain: () => void = () => {}
  const transport: MultiplexerTransport = {
    supportsWriteSettlement: true,
    write: (data, settled) => {
      writes.push(data)
      settlements.push(settled!)
      return writeResults.shift() ?? true
    },
    onData: (callback) => {
      receive = callback
    },
    onDrain: (callback) => {
      drain = callback
      return removeDrain
    },
    onClose: () => {},
    close
  }
  return {
    transport,
    writes,
    settlements,
    close,
    removeDrain,
    drain: () => drain(),
    receive: (data: Buffer) => receive(data)
  }
}

function multiplexer(writeResults: boolean[] = []) {
  const f = fixture(writeResults)
  const mux = new SshChannelMultiplexer(f.transport)
  cleanups.push(() => mux.dispose())
  return { ...f, mux }
}

function revoke() {
  profile.assertCurrent.mockImplementation(() => {
    throw new Error('profile_lifetime_identity_changed')
  })
}

it('rejects requests on an established connection without handing off bytes after revocation', async () => {
  const f = multiplexer()
  const established = f.mux.request('relay.status')
  const request = JSON.parse(f.writes[0].subarray(HEADER_LENGTH).toString())
  f.settlements[0]({ ok: true })
  f.receive(encodeJsonRpcFrame({ jsonrpc: '2.0', id: request.id, result: 'ready' }, 1, 1))
  await expect(established).resolves.toBe('ready')
  revoke()
  await expect(f.mux.request('pty.create', {})).rejects.toMatchObject({ code: 'CONNECTION_LOST' })
  expect(f.writes).toHaveLength(1)
  expect(f.mux.isDisposed()).toBe(true)
  expect(f.close).toHaveBeenCalledOnce()
})

it.each(['ordinary', 'control'] as const)(
  'refuses queued %s frames at the backpressure drain boundary',
  (lane) => {
    const f = fixture([false])
    const failed = vi.fn()
    const writer = new SshMultiplexerTransportWriter(f.transport, failed)
    cleanups.push(() => writer.dispose())
    const first = vi.fn()
    const queued = vi.fn()
    writer.enqueue(Buffer.from('handed-off'), 'ordinary', first)
    writer.enqueue(Buffer.from('queued'), lane, queued)
    revoke()
    expect(() => f.drain()).not.toThrow()
    expect(f.writes.map(String)).toEqual(['handed-off'])
    expect(queued).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'refused', reason: 'write_gate_denied' })
    )
    expect(first).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: 'unverifiable',
        reason: 'transport_settlement_lost',
        bytesHandedToTransport: true
      })
    )
    f.settlements[0]({ ok: true })
    expect(first).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledOnce()
    expect(f.removeDrain).toHaveBeenCalledOnce()
    expect(writer.enqueue(Buffer.from('late'), lane)).toBe(false)
  }
)

it('gates the liveness lane even when it bypasses a saturated ordinary queue', () => {
  const f = fixture([false])
  const failed = vi.fn()
  const writer = new SshMultiplexerTransportWriter(f.transport, failed)
  cleanups.push(() => writer.dispose())
  writer.enqueue(Buffer.from('handed-off'), 'ordinary')
  const settled = vi.fn()
  revoke()
  expect(() => writer.enqueue(Buffer.from('keepalive'), 'liveness', settled)).not.toThrow()
  expect(f.writes.map(String)).toEqual(['handed-off'])
  expect(settled).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: 'refused', reason: 'write_gate_denied' })
  )
  expect(failed).toHaveBeenCalledOnce()
})

it('refuses queued mux notifications and preserves uncertainty for the already handed-off frame', () => {
  const f = multiplexer([false])
  const first = vi.fn()
  const queued = vi.fn()
  f.mux.notifyWithSettlement('pty.ackData', {}, first)
  f.mux.notifyWithSettlement('pty.ackData', {}, queued)
  revoke()
  f.drain()
  expect(f.writes).toHaveLength(1)
  expect(queued).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'refused' }))
  expect(first).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: 'unverifiable', bytesHandedToTransport: true })
  )
  expect(f.mux.isDisposed()).toBe(true)
  expect(f.close).toHaveBeenCalledOnce()
})

it('contains fire-and-forget notification admission failures and closes the mux', () => {
  const f = multiplexer()
  revoke()
  expect(() => f.mux.notify('pty.ackData', {})).not.toThrow()
  expect(f.writes).toHaveLength(0)
  expect(f.mux.isDisposed()).toBe(true)
  expect(f.close).toHaveBeenCalledOnce()
})

it('resolves a liveness probe false without throwing or sending after revocation', async () => {
  const f = multiplexer()
  revoke()
  await expect(f.mux.probeLiveness(30_000)).resolves.toBe(false)
  expect(f.writes).toHaveLength(0)
  expect(f.mux.isDisposed()).toBe(true)
  expect(f.close).toHaveBeenCalledOnce()
})

it('refuses incoming RPCs before invoking their handlers', async () => {
  const f = multiplexer()
  const handler = vi.fn(() => 'must not execute')
  f.mux.onRequest('orca.cli', handler)
  revoke()
  expect(() =>
    f.receive(
      encodeJsonRpcFrame(
        { jsonrpc: '2.0', id: 1, method: 'orca.cli', params: { argv: ['status'] } },
        1,
        0
      )
    )
  ).not.toThrow()
  await vi.waitFor(() => expect(f.mux.isDisposed()).toBe(true))
  expect(handler).not.toHaveBeenCalled()
  expect(f.writes).toHaveLength(0)
  expect(f.close).toHaveBeenCalledOnce()
})

it('allows idempotent local disposal while profile admission is revoked', () => {
  const f = multiplexer()
  revoke()
  expect(() => f.mux.dispose()).not.toThrow()
  expect(() => f.mux.dispose()).not.toThrow()
  expect(f.close).toHaveBeenCalledOnce()
  expect(profile.assertCurrent).not.toHaveBeenCalled()
})

it('settles cancellation even when its cancellation notification loses admission', async () => {
  const f = multiplexer()
  const controller = new AbortController()
  const pending = f.mux.request('fs.read', {}, { signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  revoke()
  expect(() => controller.abort()).not.toThrow()
  await rejected
  expect(f.writes).toHaveLength(1)
  expect(f.close).toHaveBeenCalledOnce()
})

it('settles a timed-out request when cancellation closes the revoked transport', async () => {
  vi.useFakeTimers()
  const f = multiplexer()
  const pending = f.mux.request('fs.read', {}, { timeoutMs: 100 })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' })
  revoke()
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(f.writes).toHaveLength(1)
  expect(f.close).toHaveBeenCalledOnce()
})
