import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
import { resolveWithSshG } from './ssh-config-parser'
import type { SshTransportCloseLedger } from './ssh-transport-close-ledger'
import type { SshConnectionWorkLedger } from './ssh-connection-work-ledger'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
beforeEach(resetSshConnectionMocks)
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function fixture() {
  const conn = new SshConnection(createTarget(), createCallbacks(), { automaticReconnect: false })
  const closed = vi.fn()
  const remove = conn.subscribeTransportClosure(closed)
  await conn.connect()
  const client = conn.getClient()!
  vi.spyOn(client, 'end').mockImplementation(() => client)
  return { conn, client, closed, remove }
}

it('notifies only after disposal and physical client closure, including late subscribers', async () => {
  const f = await fixture()
  expect(f.closed).not.toHaveBeenCalled()
  await f.conn.disconnect()
  expect(f.closed).not.toHaveBeenCalled()
  f.client.emit('close')
  expect(f.closed).toHaveBeenCalledOnce()
  const late = vi.fn()
  f.conn.subscribeTransportClosure(late)
  expect(late).toHaveBeenCalledOnce()
  f.client.emit('close')
  expect(f.closed).toHaveBeenCalledOnce()
  expect(late).toHaveBeenCalledOnce()
})

it('remembers physical closure before disposal but does not report it early', async () => {
  const f = await fixture()
  f.client.emit('close')
  expect(f.closed).not.toHaveBeenCalled()
  await f.conn.disconnect()
  expect(f.closed).toHaveBeenCalledOnce()
})

it('holds notification through tracked work and both forwarded resources', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<void>()
  const operation = f.conn.prepareForwardRoute(() => pending.promise)
  const socket = new EventEmitter()
  const channel = new EventEmitter()
  f.client.forwardOut = vi.fn((_a, _b, _c, _d, callback) => {
    callback?.(undefined, channel as never)
    return f.client
  })
  f.conn.forwardOut(f.client, socket, '127.0.0.1', 0, 'host', 443, vi.fn())
  await f.conn.disconnect()
  f.client.emit('close')
  channel.emit('close')
  expect(f.closed).not.toHaveBeenCalled()
  socket.emit('close')
  expect(f.closed).not.toHaveBeenCalled()
  pending.resolve()
  await operation
  expect(f.closed).toHaveBeenCalledOnce()
})

it('waits for every allocated proxy even after its active pointer is cleared', async () => {
  const f = await fixture()
  const proxy = new EventEmitter()
  const ledger = (f.conn as unknown as { transportCloseLedger: SshTransportCloseLedger })
    .transportCloseLedger
  ledger.track(proxy)
  await f.conn.disconnect()
  f.client.emit('close')
  expect(f.closed).not.toHaveBeenCalled()
  proxy.emit('close')
  expect(f.closed).toHaveBeenCalledOnce()
})

it('unsubscribes without changing ordinary disconnection', async () => {
  const f = await fixture()
  f.remove()
  await f.conn.disconnect()
  f.client.emit('close')
  expect(f.closed).not.toHaveBeenCalled()
})

it('isolates observer failures from disconnect and other observers', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  conn.subscribeTransportClosure(() => {
    throw new Error('observer')
  })
  const observed = vi.fn()
  conn.subscribeTransportClosure(observed)
  await expect(conn.disconnect()).resolves.toBeUndefined()
  expect(observed).toHaveBeenCalledOnce()
})

it('never treats unproven system SSH cleanup as physical closure', async () => {
  vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
  const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
  const observed = vi.fn()
  conn.subscribeTransportClosure(observed)
  await conn.connect()
  await conn.disconnect()
  expect(observed).not.toHaveBeenCalled()
})

it.each(['initial', 'reconnect', 'system'] as const)(
  'waits for active %s allocation work',
  async (kind) => {
    const f = kind === 'reconnect' ? await fixture() : null
    const conn =
      f?.conn ?? new SshConnection(createTarget(), createCallbacks(), { automaticReconnect: false })
    const observed = vi.fn()
    conn.subscribeTransportClosure(observed)
    const config = Promise.withResolvers<null>()
    vi.mocked(resolveWithSshG).mockReturnValueOnce(config.promise)
    const opening = (
      kind === 'initial'
        ? conn.connect()
        : kind === 'reconnect'
          ? conn.reconnect()
          : conn.connectViaSystemSsh()
    ).catch(() => {})
    await conn.disconnect()
    f?.client.emit('close')
    expect(observed).not.toHaveBeenCalled()
    config.resolve(null)
    await opening
    expect(observed).toHaveBeenCalledTimes(kind === 'system' ? 0 : 1)
  }
)

it('retains failed ledger drainage rather than signaling successful closure', async () => {
  const f = await fixture()
  const work = (f.conn as unknown as { workLedger: SshConnectionWorkLedger }).workLedger
  const opening = work.beginChannelOpen()
  work.fenceForReset()
  opening.close(new Error('unproven channel'))
  await f.conn.disconnect()
  f.client.emit('close')
  expect(f.closed).not.toHaveBeenCalled()
})

it('refuses fresh forwarding work after notifying physical closure', async () => {
  const f = await fixture()
  await f.conn.disconnect()
  f.client.emit('close')
  expect(f.closed).toHaveBeenCalledOnce()
  const allocate = vi.fn(() => new EventEmitter())
  const prepare = vi.fn(async () => {})
  expect(() => f.conn.openForwardSocket(allocate)).toThrow(
    expect.objectContaining({ name: 'AbortError' })
  )
  await expect(f.conn.prepareForwardRoute(prepare)).rejects.toMatchObject({ name: 'AbortError' })
  expect(allocate).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})
