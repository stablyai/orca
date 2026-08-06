import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import WebSocketClient, { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { DeviceRegistry } from '../device-registry'
import { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import { CloudRelayTransport } from '../rpc/relay-transport'
import { deriveRelayHostId } from './relay-http-client'
import { SimulatedMobileE2EEV2Peer } from './simulated-mobile-e2ee-v2-peer'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function waitForOpen(socket: WebSocketClient): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function nextText(socket: WebSocketClient): Promise<string> {
  return new Promise((resolve) => {
    socket.once('message', (raw) => resolve(raw.toString()))
  })
}

function forward(socket: WebSocket, raw: RawData, isBinary: boolean): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(raw, { binary: isBinary })
  }
}

describe('desktop relay E2EE integration', () => {
  const servers: WebSocketServer[] = []
  const transports: CloudRelayTransport[] = []
  const userDataPaths: string[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.stop()))
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) {
              client.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
    for (const path of userDataPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('splices a simulated phone through CloudRelayTransport with real NaCl E2EE v2', async () => {
    const relay = new WebSocketServer({ port: 0, perMessageDeflate: false })
    servers.push(relay)
    await new Promise<void>((resolve) => relay.once('listening', resolve))
    const address = relay.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected local relay TCP address')
    }
    let hostSocket: WebSocket | null = null
    let phoneSocket: WebSocket | null = null
    let phoneAuthorized = false
    const maybeSplice = (): void => {
      if (!hostSocket || !phoneSocket || !phoneAuthorized) {
        return
      }
      const host = hostSocket
      const phone = phoneSocket
      host.on('message', (raw, isBinary) => forward(phone, raw, isBinary))
      phone.on('message', (raw, isBinary) => forward(host, raw, isBinary))
      phone.send(
        JSON.stringify({
          type: 'relay-hello',
          ok: true,
          credentialKind: 'invite',
          leaseExpiresAt: Date.now() + 60_000
        })
      )
    }
    relay.on('connection', (socket, request) => {
      expect(request.url).not.toContain('?')
      if (request.url === '/v1/host/data/connection-1') {
        socket.once('message', (raw) => {
          expect(JSON.parse(raw.toString())).toEqual({
            type: 'host-data-auth',
            v: 1,
            connTicket: 'A'.repeat(43),
            generation: 1
          })
          hostSocket = socket
          maybeSplice()
        })
        return
      }
      if (request.url?.startsWith('/v1/connect/')) {
        socket.once('message', (raw) => {
          expect(JSON.parse(raw.toString())).toEqual({
            type: 'relay-auth',
            v: 1,
            mode: 'connect',
            credential: 'B'.repeat(43)
          })
          phoneSocket = socket
          phoneAuthorized = true
          maybeSplice()
        })
      }
    })

    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-e2ee-'))
    userDataPaths.push(userDataPath)
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone', 'mobile')
    const desktopKeys = nacl.box.keyPair()
    const relayHostId = deriveRelayHostId(desktopKeys.publicKey)
    const receivedText = deferred<string>()
    const receivedBinary = deferred<Uint8Array>()
    const phoneBinary = deferred<Uint8Array>()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: {
        publicKey: desktopKeys.publicKey,
        secretKey: desktopKeys.secretKey,
        publicKeyB64: Buffer.from(desktopKeys.publicKey).toString('base64')
      },
      onText: (socket, plaintext, reply, sendBinary) => {
        expect(socket.transport).toEqual({
          transport: 'relay',
          relayHostId,
          relayDeviceId: device.deviceId,
          basisConnId: 'connection-1',
          credentialKind: 'invite'
        })
        receivedText.resolve(plaintext)
        reply(JSON.stringify({ id: 'rpc-1', ok: true, result: { path: 'relay' } }))
        sendBinary(new Uint8Array([4, 5, 6]))
      },
      onBinary: (_socket, bytes) => receivedBinary.resolve(new Uint8Array(bytes)),
      onClose: vi.fn()
    })
    const transport = new CloudRelayTransport({
      cellUrl: `http://127.0.0.1:${address.port}`,
      relayHostId,
      generation: 1
    })
    transports.push(transport)
    wiring.attachTransport(transport, (socket) => transport.metadataFor(socket))
    await transport.start()
    await transport.openConnection({
      connId: 'connection-1',
      connTicket: 'A'.repeat(43),
      kind: 'invite',
      relayDeviceId: device.deviceId,
      attachDeadlineMs: 5_000
    })

    const phone = new WebSocketClient(`ws://127.0.0.1:${address.port}/v1/connect/${relayHostId}`, {
      perMessageDeflate: false
    })
    await waitForOpen(phone)
    const relayHello = nextText(phone)
    phone.send(
      JSON.stringify({
        type: 'relay-auth',
        v: 1,
        mode: 'connect',
        credential: 'B'.repeat(43)
      })
    )
    await expect(relayHello).resolves.toMatch('"ok":true')

    const authenticated = deferred<void>()
    const phoneText = deferred<string>()
    const phoneSession = new SimulatedMobileE2EEV2Peer(
      nacl.box.keyPair(),
      desktopKeys.publicKey,
      relayHostId
    )
    let phoneState: 'awaiting-ready' | 'awaiting-authenticated' | 'ready' = 'awaiting-ready'
    phone.on('message', (raw, isBinary) => {
      if (phoneState === 'awaiting-ready') {
        expect(isBinary).toBe(false)
        expect(phoneSession.acceptReady(JSON.parse(raw.toString()))).toBe(true)
        phoneState = 'awaiting-authenticated'
        phone.send(
          phoneSession.sealText(
            JSON.stringify({
              type: 'e2ee_auth',
              v: 2,
              transcriptHashB64: phoneSession.transcriptHashB64,
              deviceToken: device.token
            })
          )
        )
        return
      }
      const plaintext = isBinary
        ? phoneSession.openBinary(new Uint8Array(raw as Buffer))
        : phoneSession.openText(raw.toString())
      expect(plaintext).not.toBeNull()
      if (phoneState === 'awaiting-authenticated') {
        expect(JSON.parse(plaintext as string)).toEqual({
          type: 'e2ee_authenticated',
          v: 2,
          transcriptHashB64: phoneSession.transcriptHashB64
        })
        phoneState = 'ready'
        authenticated.resolve()
      } else if (typeof plaintext === 'string') {
        phoneText.resolve(plaintext)
      } else {
        phoneBinary.resolve(plaintext!)
      }
    })
    phone.send(JSON.stringify(phoneSession.hello))
    await authenticated.promise
    phone.send(phoneSession.sealText(JSON.stringify({ id: 'rpc-1', method: 'status.get' })))
    phone.send(phoneSession.sealBinary(new Uint8Array([1, 2, 3])))

    await expect(receivedText.promise).resolves.toBe(
      JSON.stringify({ id: 'rpc-1', method: 'status.get' })
    )
    await expect(receivedBinary.promise).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await expect(phoneText.promise).resolves.toBe(
      JSON.stringify({ id: 'rpc-1', ok: true, result: { path: 'relay' } })
    )
    await expect(phoneBinary.promise).resolves.toEqual(new Uint8Array([4, 5, 6]))

    phone.terminate()
  }, 15_000)
})
