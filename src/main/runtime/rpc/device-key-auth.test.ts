import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { encodeDeviceProofMessage, type DeviceProofPurpose } from '../../../shared/device-key-proof'
import { DeviceRegistry } from '../device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../mobile-pairing-files'
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

function sign(key: nacl.SignKeyPair, purpose: DeviceProofPurpose, transcriptHashB64: string) {
  const message = encodeDeviceProofMessage(purpose, Buffer.from(transcriptHashB64, 'base64'))
  return Buffer.from(nacl.sign.detached(message, key.secretKey)).toString('base64')
}

function harness(registry: DeviceRegistry, metadata?: MobileSocketTransportMetadata) {
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
  wiring.attachTransport(transport, () => metadata ?? { transport: 'direct' })

  /** Opens a direct v2 socket and sends `auth(transcriptHashB64)`; returns the decoded verdict. */
  function connect(auth: (transcriptHashB64: string) => Record<string, unknown>) {
    const ws = new FakeSocket()
    const peer = new SimulatedMobileE2EEV2Peer(
      nacl.box.keyPair(),
      desktop.publicKey,
      metadata?.transport === 'relay' ? metadata.relayHostId : null
    )
    transport.receive(ws, JSON.stringify(peer.hello))
    expect(peer.acceptReady(JSON.parse(String(ws.sent[0])))).toBe(true)
    const transcriptHashB64 = peer.transcriptHashB64
    transport.receive(
      ws,
      peer.sealText(
        JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, ...auth(transcriptHashB64) })
      )
    )
    const reply = ws.sent[1] ? JSON.parse(peer.openText(String(ws.sent[1]))!) : null
    return { ws, peer, transcriptHashB64, reply, socket: ready.at(-1) }
  }
  return { connect, ready }
}

function freshRegistry(): DeviceRegistry {
  return new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-device-key-')))
}

describe('device-key authentication (host)', () => {
  it('forks a token row per installation, then authenticates the key and keeps the token working', () => {
    const registry = freshRegistry()
    const legacy = registry.addDevice('Phone', 'mobile')
    registry.updateLastSeen(legacy.deviceId)
    const { connect } = harness(registry)

    const migrating = connect(() => ({ deviceToken: legacy.token }))
    expect(migrating.reply).toMatchObject({ type: 'e2ee_authenticated' })
    const key = nacl.sign.keyPair()
    const params = {
      devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
      deviceProofB64: sign(key, 'register', migrating.transcriptHashB64),
      deviceLabel: 'Pixel‮ evil\u0007'
    }
    const forked = registerSocketDeviceKey(registry, migrating.socket!, params)
    // A lost reply retried with the same key returns the same row.
    expect(registerSocketDeviceKey(registry, migrating.socket!, params)).toEqual(forked)
    expect(registry.getDevice(forked.deviceId)).toMatchObject({
      credentialKind: 'device-key',
      forkedFrom: legacy.deviceId,
      name: 'Pixel evil',
      scope: 'mobile'
    })
    expect(registry.getDevice(forked.deviceId)?.token).toBeUndefined()

    const keyed = connect((hash) => ({
      deviceId: forked.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(keyed.reply).toMatchObject({ type: 'e2ee_authenticated' })
    expect(keyed.socket?.device).toMatchObject({
      deviceId: forked.deviceId,
      clientId: forked.deviceId,
      callerFingerprint: migrating.socket!.device.callerFingerprint
    })
    expect(keyed.socket?.device.deviceToken).toBeUndefined()

    // Another installation holding the same token is unaffected and forks its own row.
    const other = connect(() => ({ deviceToken: legacy.token }))
    expect(other.reply).toMatchObject({ type: 'e2ee_authenticated' })
    const otherKey = nacl.sign.keyPair()
    const otherFork = registerSocketDeviceKey(registry, other.socket!, {
      devicePublicKeyB64: Buffer.from(otherKey.publicKey).toString('base64'),
      deviceProofB64: sign(otherKey, 'register', other.transcriptHashB64)
    })
    expect(otherFork.deviceId).not.toBe(forked.deviceId)
  })

  it('refuses a keyed row presented with a token, a replayed proof and a wrong-purpose proof', () => {
    const registry = freshRegistry()
    const legacy = registry.addDevice('Phone', 'mobile')
    const { connect } = harness(registry)
    const migrating = connect(() => ({ deviceToken: legacy.token }))
    const key = nacl.sign.keyPair()
    const devicePublicKeyB64 = Buffer.from(key.publicKey).toString('base64')
    expect(() =>
      registerSocketDeviceKey(registry, migrating.socket!, {
        devicePublicKeyB64,
        deviceProofB64: sign(key, 'auth', migrating.transcriptHashB64)
      })
    ).toThrow('bad_proof')
    const forked = registerSocketDeviceKey(registry, migrating.socket!, {
      devicePublicKeyB64,
      deviceProofB64: sign(key, 'register', migrating.transcriptHashB64)
    })

    const first = connect((hash) => ({
      deviceId: forked.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(first.reply).toMatchObject({ type: 'e2ee_authenticated' })
    const replayedProof = sign(key, 'auth', first.transcriptHashB64)
    const replay = connect(() => ({ deviceId: forked.deviceId, deviceProofB64: replayedProof }))
    expect(replay.reply).toEqual({ type: 'e2ee_error', error: { code: 'bad_proof' } })
    expect(replay.ws.close).toHaveBeenCalledWith(4001, 'Invalid e2ee_auth')

    const mixed = connect((hash) => ({
      deviceId: forked.deviceId,
      deviceProofB64: sign(key, 'auth', hash),
      deviceToken: legacy.token
    }))
    expect(mixed.reply).toEqual({ type: 'e2ee_error', error: { code: 'bad_auth' } })
  })

  it("accepts a fork over its token row's Relay binding and refuses other bindings without a revocation verdict", () => {
    const registry = freshRegistry()
    const legacy = registry.addDevice('Phone', 'mobile')
    const stranger = registry.addDevice('Other phone', 'mobile')
    const key = nacl.sign.keyPair()
    const forked = registry.forkDeviceKey(
      legacy.deviceId,
      Buffer.from(key.publicKey).toString('base64'),
      'Phone'
    )
    const relay = (relayDeviceId: string): MobileSocketTransportMetadata => ({
      transport: 'relay',
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId,
      basisConnId: 'basis',
      credentialKind: 'resume'
    })
    const keyAuth = (hash: string) => ({
      deviceId: forked.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    })
    expect(harness(registry, relay(legacy.deviceId)).connect(keyAuth).reply).toMatchObject({
      type: 'e2ee_authenticated'
    })
    expect(harness(registry, relay(stranger.deviceId)).connect(keyAuth).reply).toEqual({
      type: 'e2ee_error',
      error: { code: 'unauthorized' }
    })
  })

  it('answers registry_unavailable, never device_revoked, after loading a corrupt registry', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-'))
    writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), '[{"deviceId":')
    const key = nacl.sign.keyPair()
    const attempt = harness(new DeviceRegistry(userDataPath)).connect((hash) => ({
      deviceId: 'keyed',
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(attempt.reply).toEqual({ type: 'e2ee_error', error: { code: 'registry_unavailable' } })
  })

  it('never answers device_revoked for a row that exists without a key', () => {
    const registry = freshRegistry()
    const legacy = registry.addDevice('Phone', 'mobile')
    const key = nacl.sign.keyPair()
    const attempt = harness(registry).connect((hash) => ({
      deviceId: legacy.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(attempt.reply).toEqual({ type: 'e2ee_error', error: { code: 'bad_auth' } })
  })

  it('answers device_revoked only when the registry is readable', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-'))
    const key = nacl.sign.keyPair()
    const revoked = harness(new DeviceRegistry(userDataPath)).connect((hash) => ({
      deviceId: 'gone',
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(revoked.reply).toEqual({
      type: 'e2ee_error',
      error: { code: 'device_revoked', deviceId: 'gone' }
    })

    const unreadable = new DeviceRegistry(userDataPath)
    unreadable['registryUnreadable'] = true
    const unavailable = harness(unreadable).connect((hash) => ({
      deviceId: 'gone',
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(unavailable.reply).toEqual({
      type: 'e2ee_error',
      error: { code: 'registry_unavailable' }
    })
    expect(unavailable.ws.close).toHaveBeenCalledWith(4001, 'Device registry unavailable')
  })

  it('refuses registration over legacy framing', () => {
    const registry = freshRegistry()
    const legacy = registry.addDevice('Phone', 'mobile')
    const key = nacl.sign.keyPair()
    const params = {
      devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
      deviceProofB64: Buffer.alloc(64).toString('base64')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only device and transcriptHashB64.
    const legacySocket = {
      device: { deviceId: legacy.deviceId, credentialRevision: 0, deviceToken: legacy.token },
      transcriptHashB64: null
    } as unknown as AuthenticatedMobileSocket
    expect(() => registerSocketDeviceKey(registry, legacySocket, params)).toThrow(
      'device_key_requires_e2ee_v2'
    )
  })

  it('keeps keyed rows out of pairing offers and rotation, and inert for token lookups', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-'))
    const keyB64 = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')
    writeFileSync(
      join(userDataPath, DEVICE_REGISTRY_FILENAME),
      JSON.stringify([
        {
          deviceId: 'keyed',
          name: 'Phone',
          scope: 'mobile',
          pairedAt: 1,
          lastSeenAt: 0,
          credentialKind: 'device-key',
          devicePublicKeyB64: keyB64
        }
      ])
    )
    const registry = new DeviceRegistry(userDataPath)
    expect(registry.validateToken('')).toBeNull()
    expect(registry.getPendingDevice('mobile')).toBeNull()
    const offered = registry.getOrCreatePendingDevice('New', 'mobile')
    expect(offered.deviceId).not.toBe('keyed')
    registry.rotatePendingDevice('Rotated', 'mobile')
    expect(registry.getDevice('keyed')).toMatchObject({ credentialKind: 'device-key' })
    expect(registry.lookupDeviceKey('keyed')).toMatchObject({ kind: 'found' })
  })
})
