import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type Server as HttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../../browser/browser-local-https-test-certificate'
import { createAllowedClientList } from './ws-client-address-policy'
import { WsTlsCredentialsError, watchWsTlsCredentials } from './ws-tls-credentials'
import { WebSocketTransport } from './ws-transport'
import {
  createGuardedWsListener,
  resolveWsTransportNetworkGuard,
  trackUnauthenticatedClose
} from './ws-transport-network-guard'
import { UnauthenticatedClientLockout } from './ws-unauthenticated-client-lockout'

const dirs: string[] = []
const transports: WebSocketTransport[] = []

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()))
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function writeTlsFiles(key = LOCAL_HTTPS_TEST_PRIVATE_KEY) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ws-tls-'))
  dirs.push(dir)
  const certPath = join(dir, 'fullchain.pem')
  const keyPath = join(dir, 'privkey.pem')
  writeFileSync(certPath, LOCAL_HTTPS_TEST_CERTIFICATE)
  writeFileSync(keyPath, key)
  return { certPath, keyPath }
}

function fakeSocket(remoteAddress: string) {
  return Object.assign(new EventEmitter(), { remoteAddress, destroy: vi.fn() })
}

// Why a raw upgrade request: the bun test runtime's `ws` client ignores the `ca` option.
function upgradeOutcome(url: string, options: { ca?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const request = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, {
      ...options,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64')
      }
    })
    request.once('upgrade', (response, socket) => {
      socket.destroy()
      resolve(`upgrade ${response.statusCode}`)
    })
    request.once('response', (response) => resolve(`response ${response.statusCode}`))
    request.once('error', (error) => resolve(`error: ${error.message}`))
    request.end()
  })
}

describe('TLS listener', () => {
  it('serves wss:// with the configured certificate and refuses plain ws://', async () => {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      networkGuard: resolveWsTransportNetworkGuard({ tls: writeTlsFiles() })
    })
    transports.push(transport)
    await transport.start()
    expect(transport.secure).toBe(true)
    const port = transport.resolvedPort
    expect(
      await upgradeOutcome(`https://localhost:${port}`, {
        ca: LOCAL_HTTPS_TEST_CERTIFICATE
      })
    ).toBe('upgrade 101')
    expect(await upgradeOutcome(`https://localhost:${port}`)).toMatch(/^error: /)
    expect(await upgradeOutcome(`http://localhost:${port}`)).toMatch(/^error: /)
  })

  it('fails at startup when the key does not belong to the certificate', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const files = writeTlsFiles(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    expect(() => resolveWsTransportNetworkGuard({ tls: files })).toThrow(WsTlsCredentialsError)
  })

  it('swaps in renewed files without restarting the listener', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const files = writeTlsFiles()
      const setSecureContext = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watcher only calls setSecureContext.
      const server = { setSecureContext } as unknown as HttpsServer
      const stop = watchWsTlsCredentials(server, files, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(setSecureContext).not.toHaveBeenCalled()
      const later = new Date(Date.now() + 60_000)
      utimesSync(files.certPath, later, later)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(setSecureContext).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('client allowlist', () => {
  it('drops peers outside the list at TCP accept and keeps listed and loopback peers', () => {
    const { server } = createGuardedWsListener(() => {}, {
      allowedClients: createAllowedClientList(['203.0.113.0/24'])
    })
    const outsider = fakeSocket('198.51.100.1')
    const listed = fakeSocket('::ffff:203.0.113.9')
    const loopback = fakeSocket('127.0.0.1')
    for (const socket of [outsider, listed, loopback]) {
      server.emit('connection', socket)
    }
    expect(outsider.destroy).toHaveBeenCalled()
    expect(listed.destroy).not.toHaveBeenCalled()
    expect(loopback.destroy).not.toHaveBeenCalled()
  })
})

describe('unauthenticated lockout', () => {
  it('counts only sockets that close before authenticating, then refuses the source', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guard = {
      unauthenticatedClientLockout: new UnauthenticatedClientLockout({
        maxFailures: 2
      })
    }
    const authenticated = new WeakSet<WebSocket>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker only reads socket.remoteAddress.
    const request = { socket: { remoteAddress: '198.51.100.1' } } as IncomingMessage
    const connect = (authenticate: boolean) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker only subscribes to 'close'.
      const ws = new EventEmitter() as unknown as WebSocket
      trackUnauthenticatedClose(guard, ws, request, (socket) => authenticated.has(socket))
      if (authenticate) {
        authenticated.add(ws)
      }
      ws.emit('close')
    }
    connect(true)
    connect(true)
    connect(false)
    const { server } = createGuardedWsListener(() => {}, guard)
    const beforeLockout = fakeSocket('198.51.100.1')
    server.emit('connection', beforeLockout)
    expect(beforeLockout.destroy).not.toHaveBeenCalled()
    connect(false)
    const afterLockout = fakeSocket('198.51.100.1')
    server.emit('connection', afterLockout)
    expect(afterLockout.destroy).toHaveBeenCalled()
  })
})
