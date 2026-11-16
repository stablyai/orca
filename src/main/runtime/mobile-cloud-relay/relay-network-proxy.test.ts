import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { WebSocketServer } from 'ws'
import { createSocksProxy } from '../../network/proxy-socks.test-fixture'
import { setDefaultProxySessionResolver } from '../../network/electron-default-proxy-session'
import { PROXY_ENVIRONMENT_KEYS } from '../../../shared/network-proxy'
import { setMainHttpClient } from '../../network/http-client'
import {
  applyElectronProxySettings,
  resetProxyApplicationForTests
} from '../../network/proxy-settings'
import { CloudRelayTransport } from '../rpc/transports/relay-transport'
import { RelayControlClient } from './control-channel/relay-control-client'
import { exchangeRelayAuthorization, requestRelayAssignment } from './director/relay-http-client'
import { RelayAssignRateGate } from './director/relay-assign-rate-gate'
import { RelayRegionPreferenceResolver } from './region-selection/relay-region-preference'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  setMainHttpClient(null)
  setDefaultProxySessionResolver(null)
  resetProxyApplicationForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function socksRelay(mode: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP relay')
  }
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) {
          socket.terminate()
        }
        server.close(() => resolve())
      })
  )
  const proxy = await createSocksProxy(new Set([address.port]))
  cleanups.push(proxy.close)
  if (mode === 'environment') {
    for (const key of [
      ...PROXY_ENVIRONMENT_KEYS,
      'npm_config_http_proxy',
      'npm_config_https_proxy',
      'npm_config_proxy',
      'npm_config_no_proxy'
    ]) {
      vi.stubEnv(key, '')
      vi.stubEnv(key.toUpperCase(), '')
    }
    vi.stubEnv('HTTP_PROXY', `socks5h://${proxy.address}`)
  }
  let rules = ''
  const session = {
    setProxy: async (config: { proxyRules?: string }) => {
      rules = config.proxyRules ?? ''
    },
    resolveProxy: async () => (rules ? `SOCKS5 ${new URL(rules).host}` : 'DIRECT')
  }
  setDefaultProxySessionResolver(() => (mode === 'app' ? session : null))
  await applyElectronProxySettings({ httpProxyUrl: `socks5h://${proxy.address}` }, { env: {} })
  return { server, hosts: proxy.hosts, cellUrl: `http://relay.invalid:${address.port}` }
}

describe('Relay app proxy routing', () => {
  it('uses the app HTTP client for the region catalog and latency probes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected direct connection')
      })
    )
    const requests: string[] = []
    setMainHttpClient({
      proxySession: () => null,
      fetch: async (url) => {
        requests.push(url)
        return url.endsWith('/v1/regions')
          ? Response.json({
              v: 1,
              regions: [{ region: 'asia-east2', probeOrigins: ['https://cell.relay.example'] }]
            })
          : new Response('ok')
      }
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'relay-proxy-region-'))
    cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: 'https://relay.example',
      userDataPath
    })

    // A single measured region deliberately produces no preference.
    await expect(resolver.resolve()).resolves.toBeUndefined()
    expect(requests).toContain('https://relay.example/v1/regions')
    expect(requests).toContain('https://cell.relay.example/health')
  })

  it.each(['app', 'environment'])(
    'routes the control upgrade and host hello through %s SOCKS5h',
    async (mode) => {
      const { server, hosts, cellUrl } = await socksRelay(mode)
      let authorization: string | undefined
      let path: string | undefined
      let hello: unknown
      server.on('connection', (socket, request) => {
        authorization = request.headers.authorization
        path = request.url
        socket.on('message', (message) => {
          hello = JSON.parse(message.toString())
          socket.close(1000)
        })
      })
      const keys = nacl.box.keyPair()
      const client = new RelayControlClient({
        cellUrl,
        relayJwt: 'relay-token',
        relayHostId: 'AbCdEf0123_-xyZ9',
        assignmentEpoch: 1,
        identity: { userId: 'user', profileId: 'profile', organizationId: 'org' },
        keypair: { ...keys, publicKeyB64: Buffer.from(keys.publicKey).toString('base64') },
        appVersion: '1.0.0',
        onConnectionOpen: () => {},
        onDrain: () => {},
        onClose: () => {}
      })
      cleanups.push(() => client.closeNow())

      await expect(client.connect()).rejects.toThrow('relay_control_closed_1000')
      expect(hosts).toEqual(new Set(['relay.invalid']))
      expect(authorization).toBe('Bearer relay-token')
      expect(path).toBe('/v1/host/control')
      expect(hello).toMatchObject({ type: 'host-hello' })
    }
  )

  it.each(['app', 'environment'])(
    'carries Relay data through %s SOCKS5h with proxy DNS',
    async (mode) => {
      const { server, hosts, cellUrl } = await socksRelay(mode)
      const auth = new Promise<unknown>((resolve) =>
        server.once('connection', (socket) => {
          socket.once('message', (message) => resolve(JSON.parse(message.toString())))
        })
      )
      const transport = new CloudRelayTransport({
        cellUrl,
        relayHostId: 'AbCdEf0123_-xyZ9',
        generation: 7
      })
      cleanups.push(() => transport.stop())
      await transport.start()

      await expect(
        transport.openConnection({
          connId: 'conn-1',
          connTicket: 'ticket-1',
          kind: 'invite',
          relayDeviceId: 'device-1',
          attachDeadlineMs: 2_000
        })
      ).resolves.toBeUndefined()
      expect(await auth).toEqual({
        type: 'host-data-auth',
        v: 1,
        connTicket: 'ticket-1',
        generation: 7
      })
      expect(hosts).toEqual(new Set(['relay.invalid']))
    }
  )

  it('uses the app HTTP client for token exchange and director assignment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected direct connection')
      })
    )
    const requests: string[] = []
    setMainHttpClient({
      proxySession: () => null,
      fetch: async (url) => {
        requests.push(url)
        return url.endsWith('/token')
          ? Response.json({ relayToken: 'scoped-token', expiresAt: Date.now() + 300_000 })
          : Response.json({
              v: 1,
              cellUrl: 'https://cell.example',
              assignmentEpoch: 1,
              lease: 'lease'
            })
      }
    })
    const keys = nacl.box.keyPair()
    const authorization = await exchangeRelayAuthorization({
      endpoint: 'https://login.example/token',
      accessToken: 'access-token',
      keypair: { ...keys, publicKeyB64: Buffer.from(keys.publicKey).toString('base64') }
    })
    expect(authorization.relayToken).toBe('scoped-token')
    await expect(
      requestRelayAssignment({
        directorUrl: 'https://relay.example',
        relayToken: authorization.relayToken,
        relayHostId: 'AbCdEf0123_-xyZ9',
        assignRateGate: new RelayAssignRateGate()
      })
    ).resolves.toMatchObject({ cellUrl: 'https://cell.example' })
    expect(requests).toEqual(['https://login.example/token', 'https://relay.example/v1/assign'])
  })
})
