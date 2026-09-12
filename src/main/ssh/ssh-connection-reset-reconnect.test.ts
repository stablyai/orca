import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import {
  createCallbacks,
  type createSystemSshProcess,
  createTarget
} from './ssh-connection-test-fixtures'
import {
  clientInstances,
  connectWithFakeTimers,
  emitSshEvent,
  spawnSystemSshMock,
  resetSshConnectionMocks
} from './ssh-connection-test-harness'

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
afterEach(() => vi.useRealTimers())

it('retains direct system-SSH transport loss without respawning or killing the captured process', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connectViaSystemSsh()
  const proc = spawnSystemSshMock.mock.results[0]!.value as ReturnType<
    typeof createSystemSshProcess
  >
  const generation = conn.getTransportGeneration()
  const fence = conn.fenceWorkForReset()
  vi.useFakeTimers()
  for (const [onExit] of proc.onExit.mock.calls) {
    onExit(255)
  }
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('transport_unverifiable')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(conn.getTransportGeneration()).toBe(generation)
  expect(spawnSystemSshMock).toHaveBeenCalledOnce()
  expect(proc.kill).not.toHaveBeenCalled()
})

it('refuses all explicit replacement entry points without touching the captured transport', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  const client = conn.getClient()!
  const end = vi.spyOn(client, 'end')
  const generation = conn.getTransportGeneration()
  conn.fenceWorkForReset()
  await expect(conn.connect()).rejects.toThrow('replacement_refused')
  await expect(conn.reconnect()).rejects.toThrow('replacement_refused')
  await expect(conn.connectViaSystemSsh()).rejects.toThrow('replacement_refused')
  expect(conn.getClient()).toBe(client)
  expect(conn.getTransportGeneration()).toBe(generation)
  expect(end).not.toHaveBeenCalled()
  expect(clientInstances).toHaveLength(1)
})

it.each(['end', 'close', 'error'])(
  'retains %s as unverifiable and does not reconnect during reset',
  async (event) => {
    vi.useFakeTimers()
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)
    await connectWithFakeTimers(conn)
    const held = conn.openForwardSocket(() => new EventEmitter())
    const generation = conn.getTransportGeneration()
    const fence = conn.fenceWorkForReset()
    const draining = fence.drain(new AbortController().signal).catch((error: unknown) => error)
    emitSshEvent(event, ...(event === 'error' ? [new Error('lost transport')] : []))
    expect(await draining).toMatchObject({ message: 'ssh_connection_reset_transport_unverifiable' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(conn.getTransportGeneration()).toBe(generation)
    expect(clientInstances).toHaveLength(1)
    held.emit('close')
    await expect(fence.drain(new AbortController().signal)).rejects.toThrow(
      'transport_unverifiable'
    )
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'reconnecting' })
    )
  }
)

it('refuses reset while disconnected without latching the connection against initial connect', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  expect(() => conn.fenceWorkForReset()).toThrow('transport_not_connected')
  await conn.connect()
  conn.fenceWorkForReset()
})

it('does not latch replacement when the requested control-channel exemption is unproven', async () => {
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  expect(() => conn.fenceWorkForReset({})).toThrow('control_channel_unproven')
  await conn.reconnect()
  expect(clientInstances).toHaveLength(2)
})

it('keeps an independent replacement connection usable', async () => {
  const first = new SshConnection(createTarget(), createCallbacks())
  await first.connect()
  first.fenceWorkForReset()
  const replacement = new SshConnection(createTarget(), createCallbacks())
  await replacement.connect()
  await replacement.reconnect()
  expect(replacement.getState().status).toBe('connected')
  await expect(first.reconnect()).rejects.toThrow('replacement_refused')
})

it.each(['ssh2', 'system'] as const)(
  'keeps %s direct drain proof through intentional connection disposal',
  async (kind) => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await (kind === 'system' ? conn.connectViaSystemSsh() : conn.connect())
    const control = conn.openForwardSocket(() => new EventEmitter())
    const fence = conn.fenceWorkForReset(control)
    await fence.drain(new AbortController().signal)
    control.emit('close')
    fence.assertDrained()
    await conn.disconnect()
    if (kind === 'system') {
      const proc = spawnSystemSshMock.mock.results[0]!.value as ReturnType<
        typeof createSystemSshProcess
      >
      for (const [onExit] of proc.onExit.mock.calls) {
        onExit(0)
      }
    } else {
      emitSshEvent('close')
    }
    expect(conn.getState().status).toBe('disconnected')
    fence.assertDrained()
    await fence.drain(new AbortController().signal)
    await expect(conn.reconnect()).rejects.toThrow('replacement_refused')
  }
)
