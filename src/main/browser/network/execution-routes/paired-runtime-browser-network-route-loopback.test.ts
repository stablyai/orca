// An Orca Cloud route sends only the workspace's loopback through the sandbox.
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  PairingOfferSchema,
  type PairingOffer
} from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame
} from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { RemoteRuntimeTransportSubscriptionCallbacks } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import type { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport', () => ({
  subscribeRemoteRuntimeTransport: subscribe
}))

import { PairedRuntimeBrowserNetworkRoute } from './paired-runtime-browser-network-route'
import { isWorkspaceLoopbackHost } from './workspace-loopback-host'

const pairing: PairingOffer = PairingOfferSchema.parse({
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 't',
  publicKeyB64: 'k',
  pairedDeviceId: 'd',
  scope: 'runtime'
})
const lease = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 3
}

afterEach(() => {
  subscribe.mockReset()
})

describe('isWorkspaceLoopbackHost', () => {
  it('is the sandbox’s own machine: localhost, *.localhost, 127/8, ::1', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'app.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      '0.0.0.0',
      'localhost.'
    ]) {
      expect(isWorkspaceLoopbackHost(host)).toBe(true)
    }
    for (const host of [
      'github.com',
      'localhost.evil.com',
      '128.0.0.1',
      '10.0.0.1',
      'api.anthropic.com',
      '1270.0.0.1'
    ]) {
      expect(isWorkspaceLoopbackHost(host)).toBe(false)
    }
  })
})

describe('Orca Cloud route (loopbackOnly)', () => {
  it('public sites are dialed from the desktop; localhost goes through the sandbox tunnel', async () => {
    const callbacks: RemoteRuntimeTransportSubscriptionCallbacks[] = []
    const sent: Uint8Array[] = []
    subscribe.mockImplementation(
      async (...args: Parameters<typeof subscribeRemoteRuntimeTransport>) => {
        callbacks.push(args[4])
        return {
          requestId: 'r',
          close: vi.fn(),
          sendBinary: (bytes: Uint8Array) => (sent.push(bytes), true)
        }
      }
    )
    const publicTargets: { host: string; port: number }[] = []
    const route = new PairedRuntimeBrowserNetworkRoute({
      connection: pairedRuntimeConnectionFromOffer(pairing),
      lease,
      executionHostRevision: 1,
      loopbackOnly: {
        connectPublic: async (target) => {
          publicTargets.push({ host: target.host, port: target.port })
          return new PassThrough()
        }
      }
    })
    const starting = route.start()
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    callbacks[0]!.onResponse({
      id: 'browser-route',
      ok: true,
      result: { type: 'ready', tunnelGeneration: 1 },
      _meta: { runtimeId: 'runtime-a' }
    })
    const address = await starting

    const pub = await socks(address.port, 'github.com', 443)
    expect(Array.from(await readExact(pub, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(publicTargets).toEqual([{ host: 'github.com', port: 443 }])
    expect(
      sent
        .map(decodeBrowserNetworkTunnelFrame)
        .filter((f) => f?.opcode === BrowserNetworkTunnelOpcode.Open)
    ).toHaveLength(0)
    pub.destroy()

    const local = await socks(address.port, 'localhost', 3000)
    await vi.waitFor(() =>
      expect(
        sent
          .map(decodeBrowserNetworkTunnelFrame)
          .filter((f) => f?.opcode === BrowserNetworkTunnelOpcode.Open)
      ).toHaveLength(1)
    )
    callbacks[0]!.onBinary?.(
      encodeBrowserNetworkTunnelFrame({
        opcode: BrowserNetworkTunnelOpcode.Opened,
        tunnelGeneration: 1,
        streamId: 1,
        payload: new Uint8Array()
      })
    )
    expect(Array.from(await readExact(local, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(publicTargets).toHaveLength(1)
    local.destroy()
    await route.close()
  })
})

async function socks(port: number, host: string, targetPort: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write(new Uint8Array([5, 1, 0]))
  await readExact(socket, 2)
  const name = new TextEncoder().encode(host)
  const request = new Uint8Array(7 + name.byteLength)
  request.set([5, 1, 0, 3, name.byteLength], 0)
  request.set(name, 5)
  new DataView(request.buffer).setUint16(5 + name.byteLength, targetPort, false)
  socket.write(request)
  return socket
}

async function readExact(socket: Socket, size: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < size) {
    const [chunk]: unknown[] = await once(socket, 'data')
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('expected a buffer')
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, size))
}
