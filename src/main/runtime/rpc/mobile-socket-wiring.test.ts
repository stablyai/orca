import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Hello,
  type MobileE2EEV2Ready
} from '../../../shared/mobile-e2ee-v2-contract'
import { sealMobileE2EEV2Frame } from '../../../shared/mobile-e2ee-v2-framing'
import type { DeviceRegistry } from '../device-registry'
import { deriveSharedKey, encrypt, generateKeyPair } from './e2ee-crypto'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-key-schedule'
import {
  MobileSocketWiring,
  type MobileSocketTransport,
  type MobileSocketTransportMetadata
} from './mobile-socket-wiring'

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly send = vi.fn((data: string | Buffer) => this.sent.push(data))
  readonly close = vi.fn()
}

class FakeTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  private closeHandler: Parameters<MobileSocketTransport['onConnectionClose']>[0] | null = null
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(handler: Parameters<MobileSocketTransport['onConnectionClose']>[0]): void {
    this.closeHandler = handler
  }

  receive(ws: FakeSocket, message: string): void {
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }

  disconnect(ws: FakeSocket): void {
    this.closeHandler?.(null, ws as unknown as WebSocket, false)
  }
}

function registryFor(deviceId: string, token: string): DeviceRegistry {
  return {
    validateToken: (candidate: string) =>
      candidate === token
        ? {
            deviceId,
            token,
            name: 'Phone',
            scope: 'mobile' as const,
            pairedAt: 1,
            lastSeenAt: 0
          }
        : null,
    updateLastSeen: vi.fn()
  } as unknown as DeviceRegistry
}

describe('MobileSocketWiring', () => {
  it('terminates a revoked device across every attached transport', () => {
    const direct = new FakeTransport()
    const relay = new FakeTransport()
    direct.terminateClientConnections.mockReturnValue(1)
    relay.terminateClientConnections.mockReturnValue(2)
    const desktop = generateKeyPair()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      e2eeKeypair: {
        publicKey: desktop.publicKey,
        secretKey: desktop.secretKey,
        publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
      },
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(direct)
    wiring.attachTransport(relay)

    expect(wiring.terminateDeviceConnections('valid-token')).toBe(3)
    expect(direct.terminateClientConnections).toHaveBeenCalledWith('valid-token')
    expect(relay.terminateClientConnections).toHaveBeenCalledWith('valid-token')
  })

  it('preserves the legacy direct handshake, identity, and close cleanup', () => {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const onText = vi.fn()
    const onClose = vi.fn()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('device-1', 'valid-token'),
      e2eeKeypair: {
        publicKey: desktop.publicKey,
        secretKey: desktop.secretKey,
        publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
      },
      onText,
      onBinary: vi.fn(),
      onClose
    })
    wiring.attachTransport(transport)

    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )
    const sharedKey = deriveSharedKey(phone.secretKey, desktop.publicKey)
    transport.receive(
      ws,
      encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'valid-token' }), sharedKey)
    )
    transport.receive(ws, encrypt('{"id":"rpc-1","method":"status.get"}', sharedKey))

    expect(transport.setClientId).toHaveBeenCalledWith(ws, 'valid-token')
    expect(onText).toHaveBeenCalledOnce()
    expect(onText.mock.calls[0]?.[0]).toMatchObject({
      device: { deviceId: 'device-1', deviceToken: 'valid-token', scope: 'mobile' },
      transport: { transport: 'direct' }
    })

    transport.disconnect(ws)
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ ws }), false)
    expect(wiring.channelCount).toBe(0)
    expect(wiring.connectionCount).toBe(0)
  })

  it('rejects a relay socket whose immutable relayDeviceId differs from E2EE identity', () => {
    const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
    const phone = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))
    const ws = new FakeSocket()
    const transport = new FakeTransport()
    const metadata: MobileSocketTransportMetadata = {
      transport: 'relay',
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'outer-device',
      basisConnId: 'connection-1',
      credentialKind: 'invite'
    }
    const wiring = new MobileSocketWiring({
      deviceRegistry: registryFor('e2ee-device', 'valid-token'),
      e2eeKeypair: {
        publicKey: desktop.publicKey,
        secretKey: desktop.secretKey,
        publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
      },
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport, () => metadata)
    const hello: MobileE2EEV2Hello = {
      type: 'e2ee_hello',
      v: 2,
      clientPublicKeyB64: Buffer.from(phone.publicKey).toString('base64'),
      clientNonceB64: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: {
        protocol: 'orca-mobile-e2ee',
        initiator: 'mobile',
        responder: 'desktop',
        transport: 'relay',
        relayHostId: metadata.relayHostId
      }
    }
    transport.receive(ws, JSON.stringify(hello))
    const ready = JSON.parse(ws.sent[0]!.toString()) as MobileE2EEV2Ready
    const handshake = validateMobileE2EEV2Handshake(hello, ready)!
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: deriveSharedKey(phone.secretKey, desktop.publicKey),
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })
    const auth = sealMobileE2EEV2Frame({
      payload: new TextEncoder().encode(
        JSON.stringify({
          type: 'e2ee_auth',
          v: 2,
          transcriptHashB64: Buffer.from(schedule.transcriptHash).toString('base64'),
          deviceToken: 'valid-token'
        })
      ),
      key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind: 'text',
      counter: 0n
    })
    transport.receive(ws, Buffer.from(auth).toString('base64'))

    expect(transport.setClientId).not.toHaveBeenCalled()
    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized')
  })
})
