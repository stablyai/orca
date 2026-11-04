import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { encodeDeviceProofMessage } from '../../../shared/device-key-proof'
import { DeviceRegistry } from '../device-registry'
import { EPHEMERAL_DEVICE_IDLE_MS } from '../ephemeral-device-rows'
import { SimulatedMobileE2EEV2Peer } from '../mobile-cloud-relay/simulated-mobile-e2ee-v2-peer'
import { registerSocketDeviceKey } from '../runtime-rpc/runtime-rpc-device-key-registration'
import { generateKeyPair } from '../../../shared/e2ee-crypto'
import {
  MobileSocketWiring,
  type AuthenticatedMobileSocket,
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
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)
  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }
  onConnectionClose(): void {}
  receive(ws: FakeSocket, message: string): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wiring only sends, closes and reads OPEN/readyState/bufferedAmount.
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }
}

const desktop = generateKeyPair()
const RELAY_HOST_ID = 'AbCdEf0123_-xyZ9'

function harness(relay?: (deviceId: string) => MobileSocketTransportMetadata) {
  const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-web-session-')))
  const transport = new FakeTransport()
  const ready: AuthenticatedMobileSocket[] = []
  const wiring = new MobileSocketWiring({
    deviceRegistry: registry,
    e2eeKeypair: {
      publicKey: desktop.publicKey,
      secretKey: desktop.secretKey,
      publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
    },
    onText: vi.fn(),
    onBinary: vi.fn(),
    onClose: vi.fn(),
    onReady: (socket) => ready.push(socket)
  })
  let relayDeviceId = ''
  wiring.attachTransport(transport, () => (relay ? relay(relayDeviceId) : { transport: 'direct' }))

  function connect(auth: (transcriptHashB64: string) => Record<string, unknown>) {
    const ws = new FakeSocket()
    const peer = new SimulatedMobileE2EEV2Peer(
      nacl.box.keyPair(),
      desktop.publicKey,
      relay ? RELAY_HOST_ID : null
    )
    transport.receive(ws, JSON.stringify(peer.hello))
    expect(peer.acceptReady(JSON.parse(String(ws.sent[0])))).toBe(true)
    const transcriptHashB64 = peer.transcriptHashB64
    const before = ready.length
    transport.receive(
      ws,
      peer.sealText(
        JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, ...auth(transcriptHashB64) })
      )
    )
    const reply = ws.sent[1] ? JSON.parse(peer.openText(String(ws.sent[1]))!) : null
    return { ws, transcriptHashB64, reply, socket: ready.length > before ? ready.at(-1) : null }
  }
  return {
    registry,
    wiring,
    transport,
    connect,
    bindRelay: (deviceId: string) => (relayDeviceId = deviceId)
  }
}

function sign(key: nacl.SignKeyPair, purpose: 'auth' | 'register', transcriptHashB64: string) {
  const message = encodeDeviceProofMessage(purpose, Buffer.from(transcriptHashB64, 'base64'))
  return Buffer.from(nacl.sign.detached(message, key.secretKey)).toString('base64')
}

// First pairing accepts direct clients regardless of page origin; origin gating broke LAN/Tailscale web pairing (#27540).
describe('first pairing over a direct socket', () => {
  it('pairs a never-used code and keeps an already-paired browser working', () => {
    const { registry, connect } = harness()
    const pending = registry.getOrCreatePendingDevice('Browser', 'runtime')
    expect(connect(() => ({ deviceToken: pending.token })).reply).toMatchObject({
      type: 'e2ee_authenticated'
    })
    expect(registry.getDevice(pending.deviceId)?.lastSeenAt).toBeGreaterThan(0)
    expect(connect(() => ({ deviceToken: pending.token })).reply).toMatchObject({
      type: 'e2ee_authenticated'
    })
  })
})

describe('session-only browser keys', () => {
  it('registers an ephemeral row, sweeps it once idle and disconnected, and then revokes it', () => {
    const { registry, wiring, transport, connect } = harness()
    const paired = registry.addDevice('Browser', 'runtime')
    registry.updateLastSeen(paired.deviceId)
    const migrating = connect(() => ({ deviceToken: paired.token }))
    const key = nacl.sign.keyPair()
    const fork = registerSocketDeviceKey(registry, migrating.socket!, {
      devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
      deviceProofB64: sign(key, 'register', migrating.transcriptHashB64),
      ephemeral: true
    })
    expect(registry.getDevice(fork.deviceId)?.ephemeral).toBe(true)

    const keyed = connect((hash) => ({
      deviceId: fork.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(keyed.reply).toMatchObject({ type: 'e2ee_authenticated' })
    const idle = registry.getDevice(fork.deviceId)!.lastSeenAt + EPHEMERAL_DEVICE_IDLE_MS + 1
    // A live socket keeps the row however long the tab stays open.
    expect(wiring.sweepIdleEphemeralDevices(idle)).toEqual([])

    transport.receive(keyed.ws, 'ignored')
    wiring.dispose()
    expect(registry.pruneIdleEphemeralDevices(idle, () => false)).toEqual([fork.deviceId])
    const after = connect((hash) => ({
      deviceId: fork.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(after.reply).toEqual({
      type: 'e2ee_error',
      error: { code: 'device_revoked', deviceId: fork.deviceId }
    })
  })
})
