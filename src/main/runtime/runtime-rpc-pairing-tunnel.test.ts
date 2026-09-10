import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

async function startServer(): Promise<OrcaRuntimeRpcServer> {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-tunnel-')),
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  return server
}

describe('OrcaRuntimeRpcServer tunnel pairing offers', () => {
  it('embeds the advertised tunnel with the bound port and records the grant transport', async () => {
    const server = await startServer()
    const boundPort = Number(new URL(server.getWebSocketEndpoint()!).port)
    const requestedPorts: number[] = []
    server.setTunnelAdvertiser({
      getPairingTunnel: (port) => {
        requestedPorts.push(port)
        return { v: 1, kind: 'tailcat', token: 'tcTOKEN' }
      }
    })

    const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'Tunnel', tunnel: true })
    expect(offer.available).toBe(true)
    if (!offer.available) {
      return
    }
    expect(requestedPorts).toEqual([boundPort])
    expect(parsePairingCode(offer.pairingUrl)?.tunnel).toEqual({
      v: 1,
      kind: 'tailcat',
      token: 'tcTOKEN',
      port: boundPort
    })
    expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.pairingTransport).toBe('tailcat')
    expect(server.hasTunnelGrants()).toBe(true)

    // Why: re-advertising the same pending grant without the tunnel must drop the transport again,
    // or the next launch would start a tunnel nobody was given.
    const plain = server.createPairingOffer({ address: '127.0.0.1', name: 'Plain' })
    expect(plain.available && plain.deviceId).toBe(offer.deviceId)
    expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.pairingTransport).toBeUndefined()
    expect(server.hasTunnelGrants()).toBe(false)
    await server.stop()
  })

  it('reports the tunnel unavailable instead of minting a link without it', async () => {
    const server = await startServer()
    const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'Tunnel', tunnel: true })
    expect(offer).toMatchObject({ available: false, reason: 'tunnel_unavailable' })
    expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
    await server.stop()
  })

  it('leaves offers untouched when the tunnel is not requested', async () => {
    const server = await startServer()
    server.setTunnelAdvertiser({
      getPairingTunnel: () => ({ v: 1, kind: 'tailcat', token: 'tcTOKEN' })
    })
    const offer = server.createPairingOffer({ address: '100.64.1.20', name: 'LAN' })
    expect(offer.available && parsePairingCode(offer.pairingUrl)?.tunnel).toBeUndefined()
    await server.stop()
  })
})
