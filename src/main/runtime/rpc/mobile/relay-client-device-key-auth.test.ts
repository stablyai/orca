import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair } from '../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import type { RelayClientPlatform } from '../../../../shared/remote-runtime/relay/client/relay-client-platform'
import { connectRelayRpcClient } from '../../../../shared/remote-runtime/relay/client/relay-rpc-client'
import { connectSharedHost } from '../../../../shared/remote-runtime/relay/client/shared-host-relay-connection'
import { DeviceRegistry } from '../server/pairing/device-registry'
import { MobileSocketWiring, type MobileSocketTransport } from './mobile-socket-wiring'

const RELAY_HOST_ID = 'AbCdEf0123_-xyZ9'
const desktop = generateKeyPair()
const desktopPublicKeyB64 = Buffer.from(desktop.publicKey).toString('base64')

class HostSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  constructor(readonly toClient: (frame: string | Buffer) => void) {}
  readonly send = (data: string | Buffer) => setImmediate(() => this.toClient(data))
  readonly close = vi.fn()
}

/**
 * The owner's real host E2EE server behind a stand-in relay cell. The cell accepts any relay
 * credential, then pipes frames both ways; the host answers every request with what it read.
 */
function relayToHost(
  registry: DeviceRegistry,
  relayDeviceId: string,
  // Resolves when the cell may accept the relay credential.
  cellAccepts: Promise<void> = Promise.resolve()
) {
  let handler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  const transport: MobileSocketTransport = {
    onMessage: (next) => {
      handler = next
    },
    onConnectionClose: () => {},
    setClientId: () => {},
    terminateClientConnections: () => 0
  }
  const requests: Record<string, unknown>[] = []
  // What the host's socket says the client reads, as each request finds it.
  const capabilities: (readonly string[])[] = []
  const wiring = new MobileSocketWiring({
    deviceRegistry: registry,
    e2eeKeypair: { ...desktop, publicKeyB64: desktopPublicKeyB64 },
    onText: (socket, plaintext, reply) => {
      const request = JSON.parse(plaintext) as Record<string, unknown>
      requests.push(request)
      capabilities.push(socket.clientCapabilities)
      reply(JSON.stringify({ id: request.id, ok: true, result: socket.device.deviceId }))
    },
    onBinary: () => {},
    onClose: () => {}
  })
  wiring.attachTransport(transport, () => ({
    transport: 'relay',
    relayHostId: RELAY_HOST_ID,
    relayDeviceId,
    basisConnId: 'basis',
    credentialKind: 'invite'
  }))
  const platform: RelayClientPlatform = {
    ...NODE_RELAY_CLIENT_PLATFORM,
    createSocket: (_url, events) => {
      const host = new HostSocket((frame) =>
        events.onMessage(typeof frame === 'string' ? frame : new Uint8Array(frame))
      )
      let relayAuthenticated = false
      setImmediate(events.onOpen)
      return {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        close: () => {},
        send: (frame) => {
          if (!relayAuthenticated) {
            relayAuthenticated = true
            const hello = { type: 'relay-hello', ok: true, credentialKind: 'invite' }
            void cellAccepts.then(() =>
              events.onMessage(JSON.stringify({ ...hello, leaseExpiresAt: 1 }))
            )
            return
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wiring only sends, closes and reads OPEN/readyState/bufferedAmount.
          handler?.(String(frame), () => {}, host as unknown as WebSocket)
        }
      }
    }
  }
  return { platform, requests, capabilities }
}

describe('relay client authentication against the host', () => {
  it('signs in with a device key and sends no token; a phone token still signs in and stamps it', async () => {
    const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-relay-client-')))
    const phone = registry.addDevice('Phone', 'mobile')
    const key = nacl.sign.keyPair()
    const keyed = registry.forkDeviceKey(
      phone.deviceId,
      Buffer.from(key.publicKey).toString('base64'),
      'Laptop'
    )

    const shared = relayToHost(registry, phone.deviceId)
    const sharedClient = connectSharedHost({
      platform: shared.platform,
      connection: {
        kind: 'shared-host',
        relay: { cellUrl: 'https://cell.example', relayHostId: RELAY_HOST_ID },
        hostPublicKeyB64: desktopPublicKeyB64,
        deviceId: keyed.deviceId,
        relayCredential: { kind: 'invite', inviteToken: 'invite' }
      },
      sign: async (message) => nacl.sign.detached(message, key.secretKey),
      clientCapabilities: []
    })
    await expect(sharedClient.sendRequest('status.get')).resolves.toMatchObject({
      ok: true,
      result: keyed.deviceId
    })
    expect(shared.requests[0]).not.toHaveProperty('deviceToken')
    sharedClient.close()

    const token = relayToHost(registry, phone.deviceId)
    const phoneClient = connectRelayRpcClient({
      platform: token.platform,
      endpoint: { cellUrl: 'https://cell.example', relayHostId: RELAY_HOST_ID },
      credential: 'invite',
      expectedCredentialKind: 'invite',
      authCredential: { kind: 'token', deviceToken: phone.token! },
      desktopPublicKeyB64
    })
    await expect(phoneClient.sendRequest('status.get')).resolves.toMatchObject({
      ok: true,
      result: phone.deviceId
    })
    expect(token.requests[0]).toMatchObject({ deviceToken: phone.token })
    phoneClient.close()
  })
  it('declares the shared-host client’s capabilities to the host, which gates every chat call on them', async () => {
    const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-relay-client-')))
    const phone = registry.addDevice('Phone', 'mobile')
    const key = nacl.sign.keyPair()
    const keyed = registry.forkDeviceKey(
      phone.deviceId,
      Buffer.from(key.publicKey).toString('base64'),
      'Laptop'
    )
    const shared = relayToHost(registry, phone.deviceId)
    const client = connectSharedHost({
      platform: shared.platform,
      connection: {
        kind: 'shared-host',
        relay: { cellUrl: 'https://cell.example', relayHostId: RELAY_HOST_ID },
        hostPublicKeyB64: desktopPublicKeyB64,
        deviceId: keyed.deviceId,
        relayCredential: { kind: 'invite', inviteToken: 'invite' }
      },
      sign: async (message) => nacl.sign.detached(message, key.secretKey),
      clientCapabilities: ['structured.v1', 'agent_session.turn_item']
    })
    await client.sendRequest('agentSession.history')
    expect(shared.capabilities[0]).toEqual(['structured.v1', 'agent_session.turn_item'])
    client.close()
  })
  it('never sends a request that timed out before the host authenticated', async () => {
    const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-relay-client-')))
    const phone = registry.addDevice('Phone', 'mobile')
    let accept!: () => void
    const cell = relayToHost(registry, phone.deviceId, new Promise((resolve) => (accept = resolve)))
    let authenticated!: () => void
    const signedIn = new Promise<void>((resolve) => (authenticated = resolve))
    const client = connectRelayRpcClient(
      {
        platform: cell.platform,
        endpoint: { cellUrl: 'https://cell.example', relayHostId: RELAY_HOST_ID },
        credential: 'invite',
        expectedCredentialKind: 'invite',
        authCredential: { kind: 'token', deviceToken: phone.token! },
        desktopPublicKeyB64,
        requestTimeoutMs: 10
      },
      { onAuthenticated: () => authenticated() }
    )
    await expect(client.sendRequest('status.get')).rejects.toThrow('relay RPC timed out')
    accept()
    await signedIn
    await new Promise((resolve) => setImmediate(resolve))
    expect(cell.requests).toEqual([])
    client.close()
  })
})
