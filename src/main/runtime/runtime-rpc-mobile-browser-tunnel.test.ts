import { createServer, connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelEvent } from '../../shared/browser-client-host-protocol'
import {
  BrowserNetworkTunnelOpcode as Opcode,
  encodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelOpen
} from '../../shared/browser-network-tunnel-protocol'
import {
  browserNetworkExecutionHostKey,
  resolveNativeBrowserNetworkExecutionRoute
} from '../browser/browser-network-execution-route'
import { sendEncryptedWsRequest } from './runtime-rpc-mobile-ws-test-harness'
import {
  mobileBrowserTunnelFixture,
  mobileTunnelCapabilities
} from './runtime-rpc-mobile-browser-tunnel-fixture'
import { encryptBytes } from './rpc/e2ee-crypto'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../shared/terminal-stream-protocol'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})
async function fixture(...args: Parameters<typeof mobileBrowserTunnelFixture>) {
  const result = await mobileBrowserTunnelFixture(...args)
  cleanups.push(result.close)
  return result
}
async function destination(marker: string) {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', () => socket.write(marker))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('missing test port')
  }
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { port: address.port, sockets }
}
async function openStream(
  peer: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['connect']>>,
  generation: number,
  port: number,
  host = '127.0.0.1'
) {
  peer.binary({
    opcode: Opcode.Open,
    tunnelGeneration: generation,
    streamId: 1,
    payload: encodeBrowserNetworkTunnelOpen({ host, port })
  })
  await vi.waitFor(() =>
    expect(peer.frames.some((frame) => frame.opcode === Opcode.Opened)).toBe(true)
  )
  peer.binary({
    opcode: Opcode.WindowUpdate,
    tunnelGeneration: generation,
    streamId: 1,
    payload: encodeBrowserNetworkTunnelWindowUpdate(65536)
  })
  peer.binary({
    opcode: Opcode.Data,
    tunnelGeneration: generation,
    streamId: 1,
    payload: new TextEncoder().encode('local fixture request')
  })
}

describe('authenticated mobile browser tunnel admission', () => {
  it('requires a runtime-created native page grant, fences retirement, and preserves a terminal connection', async () => {
    const target = await destination('NATIVE_FIXTURE')
    const f = await fixture()
    const host = await f.host()
    const tunnel = await f.connect(host.peer.url)
    const terminal = await f.connect(host.peer.url, [])
    const multiplex = terminal.send('terminal.multiplex', {})
    expect(await terminal.reader.next(multiplex)).toMatchObject({
      ok: true,
      result: { type: 'ready' }
    })
    async function terminalRoundtrip(streamId: number) {
      terminal.session.ws.send(
        encryptBytes(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({ streamId, terminal: 'missing-fixture-terminal' })
          }),
          terminal.session.sharedKey
        )
      )
      expect(
        await terminal.reader.next(multiplex, (response) => {
          const result = response.result
          return (
            typeof result === 'object' &&
            result !== null &&
            'type' in result &&
            result.type === 'error'
          )
        })
      ).toMatchObject({
        ok: true,
        result: { type: 'error', streamId }
      })
    }
    await terminalRoundtrip(1)
    expect(await tunnel.call('network.browserTunnel', host.params())).toMatchObject({
      ok: false,
      error: { message: 'browser_tunnel_execution_host_not_granted' }
    })
    expect(target.sockets.size).toBe(0)
    const page = await host.page()
    const request = tunnel.send('network.browserTunnel', host.params())
    const ready = BrowserNetworkTunnelEvent.parse((await tunnel.reader.next(request)).result)
    expect(ready.type).toBe('ready')
    await openStream(tunnel, ready.tunnelGeneration, target.port)
    await vi.waitFor(() =>
      expect(
        tunnel.frames.some((frame) => new TextDecoder().decode(frame.payload) === 'NATIVE_FIXTURE')
      ).toBe(true)
    )
    await terminalRoundtrip(2)
    expect(page.retire()).toBe(true)
    expect(await tunnel.reader.next(request)).toMatchObject({
      ok: true,
      result: { type: 'closed' }
    })
    await vi.waitFor(() => expect(target.sockets.size).toBe(0))
    expect(await tunnel.call('network.browserTunnel', host.params())).toMatchObject({ ok: false })
    await terminalRoundtrip(3)
    expect(await terminal.call('status.get', {})).toMatchObject({
      ok: true,
      result: { deviceScope: 'mobile' }
    })
  })

  it('refuses unnegotiated, wrong owner, token, generation, epoch and route requests before opening', async () => {
    const f = await fixture()
    const host = await f.host()
    await host.page()
    const tunnel = await f.connect(host.peer.url)
    for (const capabilities of [
      [],
      mobileTunnelCapabilities.filter((c) => c !== 'browser.clientHost.mobileTunnel.v1'),
      mobileTunnelCapabilities.filter((c) => c !== 'browser.clientHost.mobileLease.v1')
    ]) {
      const old = await f.connect(host.peer.url, capabilities)
      expect(await old.call('network.browserTunnel', host.params())).toMatchObject({
        ok: false,
        error: { code: 'forbidden' }
      })
    }
    const other = await f.connect()
    expect(await other.call('network.browserTunnel', host.params())).toMatchObject({ ok: false })
    for (const override of [
      { authorityRuntimeId: 'wrong-runtime' },
      { authorityEpoch: 'old-epoch' },
      { browserHostGeneration: host.lease.browserHostGeneration + 1 },
      { browserHostClientId: 'other-host' },
      { executionHost: { ...f.native, revision: f.runtime.getStartedAt() + 1 } },
      {
        executionHost: {
          kind: 'ssh',
          targetId: 'ungranted',
          providerEpoch: 'epoch',
          connectionGeneration: 1
        }
      }
    ]) {
      expect(
        await tunnel.call('network.browserTunnel', { ...host.params(), ...override })
      ).toMatchObject({ ok: false })
    }
    sendEncryptedWsRequest(tunnel.session, {
      id: 'wrong-token',
      method: 'network.browserTunnel',
      params: host.params(),
      deviceToken: 'wrong-token'
    })
    expect(await tunnel.reader.next('wrong-token')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })
    const request = tunnel.send('network.browserTunnel', host.params())
    expect(await tunnel.reader.next(request)).toMatchObject({ ok: true, result: { type: 'ready' } })
    host.peer.session.ws.close()
    expect(await tunnel.reader.next(request)).toMatchObject({
      ok: true,
      result: { type: 'closed' }
    })
  })

  it('refuses a pending attach after the same-generation lease connection is replaced', async () => {
    let finish = () => {}
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    const close = vi.fn()
    const resolver = vi.fn(
      async (context: Parameters<typeof resolveNativeBrowserNetworkExecutionRoute>[0]) => {
        await barrier
        return { ...resolveNativeBrowserNetworkExecutionRoute(context), close }
      }
    )
    const f = await fixture(resolver)
    cleanups.push(finish)
    const host = await f.host(true)
    const page = await host.page()
    const tunnel = await f.connect(host.peer.url)
    const request = tunnel.send('network.browserTunnel', host.params())
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    const replacement = await f.connect(host.peer.url)
    const attach = replacement.send('browser.clientHost.attach', {
      ...host.lease,
      pageInventory: [
        {
          ...page.placement,
          authorityRuntimeId: host.lease.authorityRuntimeId,
          authorityEpoch: host.lease.authorityEpoch,
          browserPageId: page.browserPageId,
          browserProfileId: 'default',
          executionHostKey: browserNetworkExecutionHostKey(f.native),
          state: 'active',
          currentUrl: 'about:blank'
        }
      ]
    })
    const restored = await replacement.reader.next(attach)
    expect(restored.error).toBeUndefined()
    expect(restored).toMatchObject({
      ok: true,
      result: {
        type: 'ready',
        browserHostGeneration: host.lease.browserHostGeneration
      }
    })
    finish()
    expect(await tunnel.reader.next(request)).toMatchObject({
      ok: false,
      error: { message: 'browser_host_lease_stale' }
    })
    expect(close).toHaveBeenCalledOnce()
    const fresh = tunnel.send('network.browserTunnel', host.params())
    expect(await tunnel.reader.next(fresh)).toMatchObject({ ok: true, result: { type: 'ready' } })
  })

  it('isolates two granted execution routes with equal target hostnames and folder page grants', async () => {
    const first = await destination('ROUTE_A')
    const second = await destination('ROUTE_B')
    const resolve = vi.fn(
      async ({ executionHost }: Parameters<NonNullable<Parameters<typeof fixture>[0]>>[0]) => {
        if (executionHost.kind !== 'ssh') {
          throw new Error('unexpected route')
        }
        if (executionHost.targetId === 'gone') {
          throw new Error('local fixture route unavailable')
        }
        const target = executionHost.targetId === 'a' ? first : second
        return {
          key: browserNetworkExecutionHostKey(executionHost),
          isValid: () => true,
          close: () => {},
          connect: (request: { host: string; port: number }) => {
            expect(request).toEqual({ host: 'same.fixture.test', port: 8080 })
            return connect({ host: '127.0.0.1', port: target.port })
          }
        }
      }
    )
    const f = await fixture(resolve)
    const host = await f.host()
    const route = (targetId: string) => ({
      kind: 'ssh' as const,
      targetId,
      providerEpoch: 'fixture',
      connectionGeneration: 1
    })
    const pageA = await host.page(route('a'))
    await host.page(route('b'))
    const tunnels = await Promise.all([f.connect(host.peer.url), f.connect(host.peer.url)])
    const requests: string[] = []
    for (const [index, tunnel] of tunnels.entries()) {
      const request = tunnel.send('network.browserTunnel', host.params(route(index ? 'b' : 'a')))
      requests.push(request)
      const ready = BrowserNetworkTunnelEvent.parse((await tunnel.reader.next(request)).result)
      await openStream(tunnel, ready.tunnelGeneration, 8080, 'same.fixture.test')
      await vi.waitFor(() =>
        expect(
          tunnel.frames.some(
            (frame) => new TextDecoder().decode(frame.payload) === (index ? 'ROUTE_B' : 'ROUTE_A')
          )
        ).toBe(true)
      )
    }
    expect(resolve).toHaveBeenCalledTimes(2)
    await host.page(route('gone'))
    const failed = await f.connect(host.peer.url)
    expect(await failed.call('network.browserTunnel', host.params(route('gone')))).toMatchObject({
      ok: false,
      error: { message: 'browser_tunnel_execution_host_unavailable' }
    })
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(pageA.retire()).toBe(true)
    expect(await tunnels[0].reader.next(requests[0])).toMatchObject({ result: { type: 'closed' } })
    await vi.waitFor(() => expect(first.sockets.size).toBe(0))
    expect(second.sockets.size).toBe(1)
    expect(await tunnels[0].call('network.browserTunnel', host.params(route('a')))).toMatchObject({
      ok: false
    })
    expect(resolve).toHaveBeenCalledTimes(3)
  })
})
