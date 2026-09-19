import { connect } from 'node:net'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { SshRelayNetworkTunnelTransport } from './ssh-relay-network-tunnel-transport'
import { createSshRelayBrowserNetworkRoute } from '../browser/ssh-relay-browser-network-route'
import { openExecutionRouteSocketAsDuplex } from '../browser/execution-route-socket-duplex'
import type { SshConnection } from './ssh-connection'
import { RemoteBrowserSocksServer } from '../browser/remote-browser-socks-server'
import { SshRelayPortForwardProvider } from './ssh-relay-port-forward-provider'
import type { RelayOwnerResetRequest } from '../../shared/relay-owner-reset-contract'
import { SshSessionNetworkTunnels } from './ssh-session-network-tunnels'

import { cleanup, fixture, echoServer } from './ssh-relay-network-test-fixture'

it('round-trips native TCP through both tunnel engines and drains before graceful close', async () => {
  const f = fixture()
  const port = await echoServer()
  const transport = await f.create()
  const socket = await transport.open({ host: '127.0.0.1', port })
  const chunks: Buffer[] = []
  const received = new Promise<void>((resolve, reject) => {
    socket.on('data', (data: Buffer) => {
      chunks.push(data)
      socket.settleRead(data.length)
    })
    socket.once('end', resolve)
    socket.once('error', reject)
  })
  const payload = Buffer.alloc(96 * 1024, 0x61)
  socket.end(payload)
  const drain = transport.fenceForDrain()
  await expect(transport.open({ host: '127.0.0.1', port })).rejects.toThrow('admission_closed')
  await received
  await drain.drain(new AbortController().signal)
  expect(Buffer.concat(chunks).equals(payload)).toBe(true)
  await transport.closeAfterDrain(new AbortController().signal)
  expect(f.registry.hasTunnels).toBe(false)
  expect(f.mux.isDisposed()).toBe(false)
})

function browserRoute(f: ReturnType<typeof fixture>, transport: SshRelayNetworkTunnelTransport) {
  return createSshRelayBrowserNetworkRoute({
    key: 'browser-route',
    opened: {
      tunnel: transport,
      connection: {} as SshConnection,
      assertCurrent: f.assertCurrent,
      assertAdmission: f.assertCurrent,
      release: (signal) => transport.closeAfterDrain(signal)
    },
    signal: new AbortController().signal,
    assertCurrent: f.assertCurrent,
    releaseInvalidation: vi.fn()
  })
}

it('drains a browser route through both wrappers after more than one receive window', async () => {
  const f = fixture()
  const port = await echoServer()
  const transport = await f.create()
  const route = browserRoute(f, transport)
  const socket = await openExecutionRouteSocketAsDuplex(route.connect({ host: '127.0.0.1', port }))
  const consume = (socket as typeof socket & { settleRead: (bytes: number) => void }).settleRead
  expect(consume).toBeTypeOf('function')
  const chunks: Buffer[] = []
  const received = new Promise<void>((resolve, reject) => {
    socket.on('data', (data: Buffer) => {
      chunks.push(data)
      consume(data.length)
    })
    socket.once('end', resolve)
    socket.once('error', reject)
  })
  const payload = Buffer.alloc(768 * 1024, 0x62)
  const writing = (async () => {
    for (let offset = 0; offset < payload.length; offset += 32 * 1024) {
      await new Promise<void>((resolve, reject) => {
        socket.write(payload.subarray(offset, offset + 32 * 1024), (error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
    }
    socket.end()
  })()
  const closing = route.close()
  await Promise.all([received, writing, closing])
  expect(Buffer.concat(chunks).equals(payload)).toBe(true)
  expect(f.registry.hasTunnels).toBe(false)
  expect(f.mux.isDisposed()).toBe(false)
})

it('preserves browser TCP half-close through SOCKS, wrappers and relay tunnel', async () => {
  const f = fixture()
  const port = await echoServer()
  const transport = await f.create()
  const route = browserRoute(f, transport)
  const socks = new RemoteBrowserSocksServer({
    open: (target) => openExecutionRouteSocketAsDuplex(route.connect(target))
  })
  cleanup.push(() => socks.close())
  const address = await socks.listen()
  const client = connect({ ...address, allowHalfOpen: true })
  cleanup.push(() => {
    client.destroy()
  })
  await once(client, 'connect')
  const greeting = once(client, 'data')
  client.write(Buffer.from([5, 1, 0]))
  expect((await greeting)[0]).toEqual(Buffer.from([5, 0]))
  const connected = once(client, 'data')
  client.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]))
  expect((await connected)[0]).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
  const chunks: Buffer[] = []
  client.on('data', (bytes: Buffer) => chunks.push(bytes))
  const ended = once(client, 'end')
  const payload = Buffer.alloc(96 * 1024, 0x63)
  client.end(payload)
  await ended
  expect(Buffer.concat(chunks).equals(payload)).toBe(true)
  await route.close()
  expect(f.registry.hasTunnels).toBe(false)
})

it('does not open a tunnel against a host without the negotiated capability', async () => {
  const f = fixture()
  f.readStatus.mockReturnValue({ capabilities: [] })
  await expect(f.create()).rejects.toThrow('capability_unavailable')
  expect(f.sentMethods).toEqual(['relay.status'])
  expect(f.registry.hasTunnels).toBe(false)
})

it('drains a session-tunnel public forward before closing its host handle', async () => {
  const f = fixture()
  const port = await echoServer()
  const transport = await f.create()
  const connection = {} as SshConnection
  const destinationOpen = vi.spyOn(transport, 'open')
  const provider = new SshRelayPortForwardProvider(async () => ({
    tunnel: transport,
    connection,
    assertCurrent: f.assertCurrent,
    assertAdmission: f.assertCurrent,
    release: (signal) => transport.closeAfterDrain(signal)
  }))
  const forward = await provider.start(connection, {
    id: 'forward',
    connectionId: 'target',
    localHost: '127.0.0.1',
    localPort: 0,
    remoteHost: '127.0.0.1',
    remotePort: port
  })
  cleanup.push(() => forward.close().catch(() => {}))
  const client = connect(forward.entry.localPort, '127.0.0.1')
  client.on('error', () => {})
  cleanup.push(() => {
    client.destroy()
  })
  await once(client, 'connect')
  await vi.waitFor(() => expect(destinationOpen).toHaveBeenCalledOnce())
  const chunks: Buffer[] = []
  client.on('data', (bytes: Buffer) => chunks.push(bytes))
  const closed = once(client, 'close')
  const payload = Buffer.alloc(96 * 1024, 0x65)
  client.end(payload)
  const drain = forward.fenceForDrain()
  expect(forward.retirementConfirmed).toBe(false)
  await Promise.all([closed, drain.drain(new AbortController().signal)])
  drain.assertDrained()
  expect(Buffer.concat(chunks).equals(payload)).toBe(true)
  await forward.close()
  expect(forward.retirementConfirmed).toBe(true)
  expect(f.registry.hasTunnels).toBe(false)
  expect(transport.retirementConfirmed).toBe(true)
  const requests = f.sentMethods.length
  f.mux.dispose()
  f.assertCurrent.mockImplementation(() => {
    throw new Error('owner retired')
  })
  drain.assertDrained()
  await drain.drain(new AbortController().signal)
  await forward.fenceForDrain().drain(new AbortController().signal)
  await transport.closeAfterDrain(new AbortController().signal)
  expect(f.sentMethods).toHaveLength(requests)
})

it('refuses callback-less transports before sending any request', async () => {
  const f = fixture(false)
  await expect(f.create()).rejects.toThrow('write_settlement_required')
  expect(f.sentMethods).toHaveLength(0)
})

it('requires a positive host close receipt before preserving drain across transport loss', async () => {
  const f = fixture()
  const transport = await f.create()
  const drain = transport.fenceForDrain()
  f.dispatcher.onRequest('relay.networkTunnel.close', async () => ({ closed: false }))
  await expect(transport.closeAfterDrain(new AbortController().signal)).rejects.toThrow(
    'close_unconfirmed'
  )
  expect(transport.retirementConfirmed).toBe(false)
  f.mux.dispose('connection_lost')
  await expect(drain.drain(new AbortController().signal)).rejects.toThrow()
})

it('does not reuse changed owner authority even on the same multiplexer', async () => {
  const f = fixture()
  const transport = await f.create()
  f.assertCurrent.mockImplementation(() => {
    throw new Error('owner changed')
  })
  await expect(transport.open({ host: 'host', port: 80 })).rejects.toThrow('owner changed')
  expect(() => transport.fenceForDrain()).toThrow('owner changed')
  expect(f.mux.isDisposed()).toBe(false)
})

it('retains transport loss as failed drain rather than successful close', async () => {
  const f = fixture()
  const transport = await f.create()
  const drain = transport.fenceForDrain()
  f.mux.dispose('connection_lost')
  await expect(drain.drain(new AbortController().signal)).rejects.toThrow()
  expect(transport.retirementConfirmed).toBe(false)
  await expect(transport.closeAfterDrain(new AbortController().signal)).rejects.toThrow()
})

it('isolates distinct tunnel generations sharing one notification method', async () => {
  const f = fixture()
  const port = await echoServer()
  const first = await f.create()
  const second = await f.create()
  const socket = await second.open({ host: '127.0.0.1', port })
  socket.resume()
  socket.end()
  await second.closeAfterDrain(new AbortController().signal)
  await first.closeAfterDrain(new AbortController().signal)
  expect(f.registry.hasTunnels).toBe(false)
})

const resetRequest: RelayOwnerResetRequest = {
  version: 1,
  operationId: 'reset-operation',
  runtimeIncarnation: 'runtime',
  ownerGeneration: 1,
  ownerLease: 'lease'
}

async function resetTunnel(
  f: ReturnType<typeof fixture>,
  beforeResolve: () => void,
  request = resetRequest
) {
  f.dispatcher.onRequest('relay.reset', async () => ({
    version: 1,
    operationId: request.operationId,
    runtimeIncarnation: request.runtimeIncarnation,
    prepared: true
  }))
  f.mux.fenceForRelayReset()
  await f.mux.waitForRelayResetDrain(new AbortController().signal)
  return f.mux.request('relay.reset', { ...request }, { beforeResolve })
}

it('preserves reset drain proof across adjacent disposal without minting an ordinary close receipt', async () => {
  const f = fixture()
  const transport = await f.create()
  const port = await echoServer()
  const socket = await transport.open({ host: '127.0.0.1', port })
  const chunks: Buffer[] = []
  socket.on('data', (bytes: Buffer) => {
    chunks.push(bytes)
    socket.settleRead(bytes.length)
  })
  const ended = once(socket, 'end')
  const payload = Buffer.alloc(96 * 1024, 0x72)
  socket.end(payload)
  const drain = transport.fenceForDrain()
  const signal = new AbortController().signal
  await ended
  await drain.drain(signal)
  expect(Buffer.concat(chunks).equals(payload)).toBe(true)
  const host = f.registry.fenceForDrain()
  await host.drain(signal)
  host.seal()
  await resetTunnel(f, () => {
    transport.assertResetRetirementReady(resetRequest)
    transport.confirmResetRetirement(resetRequest)
    f.mux.dispose()
  })
  f.assertCurrent.mockImplementation(() => {
    throw new Error('owner retired')
  })
  expect(transport.resetRetirementRequest).toEqual(resetRequest)
  expect(Object.isFrozen(transport.resetRetirementRequest)).toBe(true)
  expect(transport.retirementConfirmed).toBe(false)
  drain.assertDrained()
  await drain.drain(signal)
  await transport.fenceForDrain().drain(signal)
  await expect(transport.closeAfterDrain(signal)).rejects.toThrow('reset_prepared')
  expect(f.sentMethods).not.toContain('relay.networkTunnel.close')
  await expect(transport.open({ host: 'localhost', port: 80 })).rejects.toThrow()
})

it.each([
  { ownerGeneration: 2 },
  { ownerLease: 'another-owner' },
  { runtimeIncarnation: 'another-runtime' }
])('refuses reset proof for a different tunnel identity: %j', async (change) => {
  const f = fixture()
  const transport = await f.create()
  const drain = transport.fenceForDrain()
  await drain.drain(new AbortController().signal)
  const request = { ...resetRequest, ...change }
  await expect(
    resetTunnel(f, () => transport.confirmResetRetirement(request), request)
  ).rejects.toThrow('reset_identity_mismatch')
  expect(transport.resetRetirementRequest).toBeUndefined()
  f.mux.dispose()
  expect(drain.assertDrained).toThrow()
})

it('requires a real synchronous reset acknowledgment and an earlier tunnel fence', async () => {
  const f = fixture()
  const transport = await f.create()
  expect(() => transport.confirmResetRetirement(resetRequest)).toThrow('context_unproven')
  await expect(
    resetTunnel(f, () => transport.confirmResetRetirement(resetRequest))
  ).rejects.toThrow('reset_not_drained')
  expect(transport.resetRetirementRequest).toBeUndefined()
})

it('does not turn an open destination into reset drain proof', async () => {
  const f = fixture()
  const port = await echoServer()
  const transport = await f.create()
  const socket = await transport.open({ host: '127.0.0.1', port })
  socket.on('error', () => {})
  transport.fenceForDrain()
  await expect(
    resetTunnel(f, () => transport.confirmResetRetirement(resetRequest))
  ).rejects.toThrow()
  expect(transport.resetRetirementRequest).toBeUndefined()
  expect(transport.retirementConfirmed).toBe(false)
})

it('keeps the owning cohort and reset-fenced release verifiable after acknowledged disposal', async () => {
  const f = fixture()
  const cohort = new SshSessionNetworkTunnels()
  const tunnel = await cohort.open({
    mux: f.mux,
    connection: {} as SshConnection,
    providerGeneration: 1,
    owner: {
      ...f.owner,
      mode: 'negotiated',
      clientInstanceId: 'client',
      clientGeneration: 1
    },
    assertCurrent: f.assertCurrent,
    assertAdmission: f.assertCurrent
  })
  const fence = cohort.fenceForDrain()
  const signal = new AbortController().signal
  await fence.drain(signal)
  const host = f.registry.fenceForDrain()
  await host.drain(signal)
  host.seal()
  await resetTunnel(f, () => {
    fence.confirmResetRetirement(resetRequest)
    f.mux.dispose()
  })
  f.assertCurrent.mockImplementation(() => {
    throw new Error('owner retired')
  })
  fence.assertDrained()
  await fence.drain(signal)
  await cohort.release(tunnel, signal)
  expect(tunnel.retirementConfirmed).toBe(false)
  expect(f.sentMethods).not.toContain('relay.networkTunnel.close')
})
