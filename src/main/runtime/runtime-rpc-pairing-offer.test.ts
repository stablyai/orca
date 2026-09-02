import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'
import { DEVICE_REGISTRY_FILENAME, E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer', () => {
  it('creates a pairing offer for the active WebSocket transport', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      webClientRoot: userDataPath
    })

    await server.start()

    const offer = server.createPairingOffer({ address: '100.64.1.20', name: 'CLI test' })
    expect(offer.available).toBe(true)
    if (offer.available) {
      expect(offer.endpoint).toContain('100.64.1.20')
      const parsed = parsePairingCode(offer.pairingUrl)
      expect(parsed?.endpoint).toBe(offer.endpoint)
      expect(parsed?.deviceToken).toBeTruthy()
      expect(parsed?.publicKeyB64).toBeTruthy()
      expect(parsed?.scope).toBe('runtime')
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.scope).toBe('runtime')
    }

    await server.stop()
  })

  it('reports why pairing is unavailable before the WebSocket listener is ready', () => {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-')),
      enableWebSocket: true,
      wsPort: 0
    })

    expect(server.createPairingOffer({ name: 'Early test' })).toMatchObject({
      available: false,
      reason: 'websocket_unavailable',
      guidance: expect.any(String)
    })
  })

  it('reports an E2EE identity initialization failure after the local transport starts', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    mkdirSync(join(userDataPath, E2EE_KEYPAIR_FILENAME))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await server.start()
      expect(server.createPairingOffer({ name: 'E2EE failure test' })).toMatchObject({
        available: false,
        reason: 'e2ee_key_unavailable',
        guidance: expect.any(String)
      })
    } finally {
      errorSpy.mockRestore()
      await server.stop()
    }
  })

  it('reports a registry persistence failure without retaining a ghost credential', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    mkdirSync(join(userDataPath, DEVICE_REGISTRY_FILENAME))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      expect(server.createPairingOffer({ name: 'Registry failure test' })).toMatchObject({
        available: false,
        reason: 'device_registry_unavailable',
        guidance: expect.any(String)
      })
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
      await server.stop()
    }
  })

  it('rejects wildcard advertised addresses before minting a device credential', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
      expect(server.createPairingOffer({ address: '0.0.0.0', name: 'Invalid test' })).toMatchObject(
        {
          available: false,
          reason: 'invalid_advertised_endpoint',
          guidance: expect.any(String)
        }
      )
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
    } finally {
      await server.stop()
    }
  })

  it('includes a web client URL when the web bundle is served by the runtime', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      webClientRoot: userDataPath
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({ address: '100.64.1.20', name: 'Web test' })
      expect(offer.available).toBe(true)
      if (offer.available) {
        expect(offer.webClientUrl).toBeTruthy()
        const url = new URL(offer.webClientUrl!)
        expect(url.protocol).toBe('http:')
        expect(url.hostname).toBe('100.64.1.20')
        expect(url.pathname).toBe('/web-index.html')
        expect(url.search).toBe('')
        expect(url.hash).toBe(`#pairing=${encodeURIComponent(offer.pairingUrl)}`)
      }
    } finally {
      await server.stop()
    }
  })

  it('preserves proxy path prefixes in web client URLs', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      webClientRoot: userDataPath
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: 'wss://runtime.example.com/orca',
        name: 'Proxy test'
      })
      expect(offer.available).toBe(true)
      if (offer.available) {
        expect(offer.webClientUrl).toContain('https://runtime.example.com/orca/web-index.html')
      }
    } finally {
      await server.stop()
    }
  })

  it('formats pairing-address overrides for IPv6 and host-port tunnel endpoints', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      webClientRoot: userDataPath
    })

    await server.start()

    try {
      const ipv6 = server.createPairingOffer({ address: '::1', name: 'IPv6 test' })
      expect(ipv6.available).toBe(true)
      if (ipv6.available) {
        expect(ipv6.endpoint).toMatch(/^ws:\/\/\[::1\]:\d+$/)
        expect(parsePairingCode(ipv6.pairingUrl)?.endpoint).toBe(ipv6.endpoint)
      }

      const tunnel = server.createPairingOffer({
        address: 'tunnel.example.com:443',
        name: 'Tunnel test'
      })
      expect(tunnel.available).toBe(true)
      if (tunnel.available) {
        expect(tunnel.endpoint).toBe('ws://tunnel.example.com:443')
      }

      const fullUrl = server.createPairingOffer({
        address: 'wss://runtime.example.com/orca',
        name: 'Full URL test'
      })
      expect(fullUrl.available).toBe(true)
      if (fullUrl.available) {
        expect(fullUrl.endpoint).toBe('wss://runtime.example.com/orca')
      }
    } finally {
      await server.stop()
    }
  })

  it('creates mobile-scoped pairing offers for headless mobile pairing', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      webClientRoot: userDataPath
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '100.64.1.20',
        name: 'Mobile test',
        scope: 'mobile'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }

      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.scope).toBe('mobile')
      expect(offer.webClientUrl).toBeNull()
      const parsed = parsePairingCode(offer.pairingUrl)
      expect(parsed?.endpoint).toBe(offer.endpoint)
      expect(parsed?.endpoint).toContain('100.64.1.20')
    } finally {
      await server.stop()
    }
  })
})
