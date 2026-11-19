import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import {
  encodeDeviceProofMessage,
  type DeviceProofPurpose
} from '../../../../shared/remote-runtime/pairing/device-key-proof'
import { DeviceRegistry } from '../server/pairing/device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../server/pairing/mobile-pairing-files'
import { registerSocketDeviceKey } from '../server/runtime-rpc-device-key-registration'
import type { MobileSocketTransportMetadata } from './mobile-socket-wiring'
import { mobileSocketHarness as harness } from './mobile-socket-wiring.test-fixture'

function sign(key: nacl.SignKeyPair, purpose: DeviceProofPurpose, transcriptHashB64: string) {
  const message = encodeDeviceProofMessage(purpose, Buffer.from(transcriptHashB64, 'base64'))
  return Buffer.from(nacl.sign.detached(message, key.secretKey)).toString('base64')
}

function freshRegistry(): DeviceRegistry {
  return new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-device-key-')))
}

describe('device-key authentication (host)', () => {
  it('forks a pre-ticket token row per installation, then authenticates the key and keeps the token working', () => {
    // Rows paired before single-use tickets may be shared by several installations.
    const dir = mkdtempSync(join(tmpdir(), 'orca-device-key-'))
    const legacy = {
      deviceId: 'legacy-phone',
      name: 'Phone',
      token: 'legacy-token',
      scope: 'mobile' as const,
      pairedAt: 1,
      lastSeenAt: 2
    }
    writeFileSync(join(dir, DEVICE_REGISTRY_FILENAME), JSON.stringify([legacy]))
    const registry = new DeviceRegistry(dir)
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

    registry.rotatePendingDevice('New QR', 'mobile')
    expect(
      connect((keyedHash) => ({
        deviceId: forked.deviceId,
        deviceProofB64: sign(key, 'auth', keyedHash)
      })).reply
    ).toMatchObject({ type: 'e2ee_authenticated' })
    expect(registry.validateToken(legacy.token)?.deviceId).toBe(legacy.deviceId)
  })

  it('retires a ticket row once its saved-key fork signs in', () => {
    const registry = freshRegistry()
    const ticket = registry.addDevice('Browser', 'runtime')
    const { connect } = harness(registry)
    const migrating = connect(() => ({ deviceToken: ticket.token }))
    const key = nacl.sign.keyPair()
    const forked = registerSocketDeviceKey(registry, migrating.socket!, {
      devicePublicKeyB64: Buffer.from(key.publicKey).toString('base64'),
      deviceProofB64: sign(key, 'register', migrating.transcriptHashB64)
    })
    expect(registry.validateToken(ticket.token)?.deviceId).toBe(ticket.deviceId)

    const keyed = connect((hash) => ({
      deviceId: forked.deviceId,
      deviceProofB64: sign(key, 'auth', hash)
    }))
    expect(keyed.reply).toMatchObject({ type: 'e2ee_authenticated' })
    expect(registry.validateToken(ticket.token)).toBeNull()
    expect(connect(() => ({ deviceToken: ticket.token })).reply).not.toMatchObject({
      type: 'e2ee_authenticated'
    })
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

    registry.removeDevice(legacy.deviceId)
    for (const metadata of [undefined, relay(legacy.deviceId)]) {
      expect(harness(registry, metadata).connect(keyAuth).reply).toEqual({
        type: 'e2ee_error',
        error: { code: 'unauthorized' }
      })
    }
  })
})
