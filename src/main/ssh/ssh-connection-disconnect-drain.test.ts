import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import { SshConnectionManager } from './ssh-connection-manager'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import {
  clientInstances,
  nextSshClientCreation,
  resetSshConnectionMocks,
  ssh2Mock
} from './ssh-connection-test-harness'
import { resolveWithSshG } from './ssh-config-parser'

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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function fixture(conn = new SshConnection(createTarget(), createCallbacks())) {
  await conn.connect()
  const client = conn.getClient()!
  // The shared SSH mock omits once/removeListener; retain its lifecycle handlers alongside real events.
  const observed = new EventEmitter()
  const emit = client.emit.bind(client)
  Object.assign(client, {
    once: observed.once.bind(observed),
    removeListener: observed.removeListener.bind(observed),
    listenerCount: observed.listenerCount.bind(observed),
    emit: (event: string, ...args: unknown[]) => {
      emit(event, ...args)
      return observed.emit(event, ...args)
    }
  })
  const end = vi.spyOn(client, 'end').mockImplementation(() => client)
  const run = (signal = new AbortController().signal) => conn.disconnectAndDrain(signal)
  const forward = () => {
    const channel = new EventEmitter()
    client.openssh_forwardOutStreamLocal = vi.fn((_path, callback) => {
      callback(undefined, channel as never)
      return client
    })
    conn.forwardStreamLocal(client, '/owned.sock', vi.fn())
    return channel
  }
  return { conn, client, end, run, forward }
}

it('waits for failed startup sockets even after another attempt connects successfully', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks(), { automaticReconnect: false })
  ssh2Mock.connectSequence = [new Error('startup refused')]
  ssh2Mock.destroyErrorMessage = 'socket still closing'
  await expect(conn.connect()).rejects.toThrow('startup refused')
  const failed = clientInstances[0]!
  ssh2Mock.destroyErrorMessage = ''
  const f = await fixture(conn)
  const done = vi.fn()
  const draining = f.run().then(done)
  f.client.emit('close')
  // Let all resolved drain promises settle; the failed socket remains open.
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(done).not.toHaveBeenCalled()
  failed.emit('close')
  await draining
  expect(done).toHaveBeenCalledOnce()
})

it('drains a settled failed exclusive startup only after its socket physically closes', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks(), { automaticReconnect: false })
  ssh2Mock.connectSequence = [new Error('startup refused')]
  ssh2Mock.destroyErrorMessage = 'socket still closing'
  await expect(conn.connect()).rejects.toThrow('startup refused')
  const failed = clientInstances[0]!
  const done = vi.fn()
  const draining = conn.disconnectAndDrain(new AbortController().signal).then(done)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(done).not.toHaveBeenCalled()
  failed.emit('close')
  await draining
  expect(done).toHaveBeenCalledOnce()
  await expect(conn.connect()).rejects.toThrow('ssh_connection_reset_replacement_refused')
})

it('remembers failed socket closure across an early ordinary disconnect', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks(), { automaticReconnect: false })
  ssh2Mock.connectSequence = [new Error('startup refused')]
  await expect(conn.connect()).rejects.toThrow('startup refused')
  await conn.disconnect()
  await conn.disconnectAndDrain(new AbortController().signal)
})

it('allows a fenced exclusive connection with no allocations to finish cleanup', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks(), { automaticReconnect: false })
  await conn.disconnectAndDrain(new AbortController().signal)
  await expect(conn.connect()).rejects.toThrow('ssh_connection_reset_replacement_refused')
})

it('retains the real manager reservation through failed startup physical closure', async () => {
  const manager = new SshConnectionManager(createCallbacks())
  const target = createTarget()
  const created = nextSshClientCreation()
  ssh2Mock.connectSequence = [new Error('startup refused')]
  ssh2Mock.destroyErrorMessage = 'socket still closing'
  const done = vi.fn()
  const pending = manager
    .connectExclusive(target, { signal: new AbortController().signal, assertAuthority: () => {} })
    .catch(done)
  await created
  const failed = clientInstances[0]!
  await vi.waitFor(() =>
    expect(manager.getConnection(target.id)?.getState().status).toBe('disconnected')
  )
  expect(done).not.toHaveBeenCalled()
  expect(manager.hasTargetActivity(target.id)).toBe(true)
  await expect(manager.connect(target)).rejects.toThrow('exclusively_owned')
  failed.emit('close')
  await pending
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ message: 'startup refused' }))
  expect(manager.hasTargetActivity(target.id)).toBe(false)
})

it('refuses drain while configuration can still allocate a startup transport', async () => {
  const resolved = Promise.withResolvers<null>()
  vi.mocked(resolveWithSshG).mockReturnValueOnce(resolved.promise)
  const conn = new SshConnection(createTarget(), createCallbacks(), { automaticReconnect: false })
  const connecting = conn.connect().catch((error: unknown) => error)
  await expect(conn.disconnectAndDrain(new AbortController().signal)).rejects.toThrow(
    'ssh_connection_close_transport_unproven'
  )
  resolved.resolve(null)
  expect(await connecting).toBeInstanceOf(Error)
  await conn.disconnectAndDrain(new AbortController().signal)
  expect(clientInstances).toHaveLength(0)
})

it('retains the real manager reservation after abort until the startup socket closes', async () => {
  const manager = new SshConnectionManager(createCallbacks())
  const target = createTarget()
  const controller = new AbortController()
  const created = nextSshClientCreation()
  ssh2Mock.connectBehavior = 'pending'
  ssh2Mock.destroyErrorMessage = 'socket still closing'
  const done = vi.fn()
  const pending = manager
    .connectExclusive(target, { signal: controller.signal, assertAuthority: () => {} })
    .catch(done)
  await created
  const failed = clientInstances[0]!
  controller.abort()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(done).not.toHaveBeenCalled()
  expect(manager.hasTargetActivity(target.id)).toBe(true)
  await expect(manager.connect(target)).rejects.toThrow('exclusively_owned')
  failed.emit('close')
  await pending
  expect(done).toHaveBeenCalledOnce()
  expect(manager.hasTargetActivity(target.id)).toBe(false)
})

it('does not treat logical disconnection as physical client closure', async () => {
  const f = await fixture()
  const done = vi.fn()
  const draining = f.run().then(done)
  await Promise.resolve()
  expect(f.end).toHaveBeenCalledOnce()
  expect(f.conn.getState().status).toBe('disconnected')
  expect(done).not.toHaveBeenCalled()
  f.client.emit('close')
  await draining
  expect(done).toHaveBeenCalledOnce()
})

it.each(['client', 'channel'] as const)(
  'requires both physical client and channel close when %s closes first',
  async (first) => {
    const f = await fixture()
    const channel = f.forward()
    const done = vi.fn()
    const draining = f.run().then(done)
    ;(first === 'client' ? f.client : channel).emit('close')
    await Promise.resolve()
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    ;(first === 'client' ? channel : f.client).emit('close')
    await draining
    expect(done).toHaveBeenCalledOnce()
  }
)

it('subscribes before disconnect can synchronously close the client', async () => {
  const f = await fixture()
  f.end.mockImplementation(() => {
    f.client.emit('close')
    return f.client
  })
  await f.run()
  expect(f.end).toHaveBeenCalledOnce()
})

it('aborts waiting for physical close and removes its listener', async () => {
  const f = await fixture()
  const before = f.client.listenerCount('close')
  const controller = new AbortController()
  const draining = f.run(controller.signal)
  expect(f.client.listenerCount('close')).toBeGreaterThan(before)
  controller.abort()
  await expect(draining).rejects.toThrow()
  expect(f.client.listenerCount('close')).toBe(before)
  expect(f.conn.getClient()).toBeNull()
})

it('pre-aborted admission does not close the connection', async () => {
  const f = await fixture()
  await expect(f.run(AbortSignal.abort())).rejects.toThrow()
  expect(f.end).not.toHaveBeenCalled()
  await f.conn.disconnect()
})

it('aborts unresolved channel drain even after the physical client closes', async () => {
  const f = await fixture()
  const channel = f.forward()
  const controller = new AbortController()
  const draining = f.run(controller.signal)
  f.client.emit('close')
  controller.abort()
  await expect(draining).rejects.toThrow()
  expect(f.client.listenerCount('close')).toBe(0)
  channel.emit('close')
})

it('cleans owned overlapping clients but refuses unproven drain', async () => {
  const f = await fixture()
  const pending = { end: vi.fn(), destroy: vi.fn() }
  const clients = (f.conn as unknown as { pendingSsh2Clients: Set<unknown> }).pendingSsh2Clients
  clients.add(pending)
  await expect(f.run()).rejects.toThrow()
  expect(f.end).toHaveBeenCalledOnce()
  expect(pending.destroy).toHaveBeenCalledOnce()
  clients.delete(pending)
  await f.conn.disconnect()
})

it('waits for the owned proxy close as well as client close', async () => {
  const f = await fixture()
  const proxy = Object.assign(new EventEmitter(), { kill: vi.fn() })
  ;(f.conn as unknown as { proxyProcess: typeof proxy }).proxyProcess = proxy
  const done = vi.fn()
  const draining = f.run().then(done)
  expect(proxy.kill).toHaveBeenCalledOnce()
  f.client.emit('close')
  await Promise.resolve()
  expect(done).not.toHaveBeenCalled()
  proxy.emit('close')
  await draining
})

it('never schedules reconnect when a drain closes its client', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  const draining = f.run()
  f.client.emit('close')
  await draining
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.conn.getClient()).toBeNull()
  expect(f.conn.getState().reconnectAttempt).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses a disconnected connection without claiming drain proof', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await expect(conn.disconnectAndDrain(new AbortController().signal)).rejects.toThrow()
})

it('retains ordinary manager transport debt after pool removal until physical close', async () => {
  const manager = new SshConnectionManager(createCallbacks())
  const target = createTarget()
  const conn = await manager.connect(target)
  const client = conn.getClient()!
  await manager.disconnect(target.id)
  expect(manager.getConnection(target.id)).toBeUndefined()
  expect(() => manager.assertTargetTransportsClosed(target.id)).toThrow('closure_unproven')
  client.emit('close')
  expect(() => manager.assertTargetTransportsClosed(target.id)).not.toThrow()
})

it('cleans failed ordinary startup without mistaking destroy for physical close', async () => {
  const manager = new SshConnectionManager(createCallbacks())
  const target = createTarget()
  ssh2Mock.connectSequence = [new Error('startup refused')]
  ssh2Mock.destroyErrorMessage = 'socket still closing'
  await expect(manager.connect(target)).rejects.toThrow('startup refused')
  expect(manager.getConnection(target.id)).toBeUndefined()
  expect(() => manager.assertTargetTransportsClosed(target.id)).toThrow('closure_unproven')
  clientInstances[0]!.emit('close')
  expect(() => manager.assertTargetTransportsClosed(target.id)).not.toThrow()
})

it('closes owned system SSH but refuses unproven drain', async () => {
  vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
  const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
  await conn.connect()
  await expect(conn.disconnectAndDrain(new AbortController().signal)).rejects.toThrow()
  expect(conn.getState().status).toBe('disconnected')
  await conn.disconnect()
})
