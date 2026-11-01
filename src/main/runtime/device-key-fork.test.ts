import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planDeviceKeyFork } from './device-key-fork'
import { devicePrincipalOf } from './device-principal'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')

function tokenRow(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  return {
    deviceId: 'legacy',
    name: 'Laptop',
    token: 'token',
    scope: 'runtime',
    grants: ['desktop-control'],
    pairingReach: 'this-computer',
    pairedAt: 1,
    lastSeenAt: 2,
    ...overrides
  }
}

describe('planDeviceKeyFork', () => {
  it('copies authority and ownership, keeps the token row, and never widens', () => {
    const legacy = tokenRow()
    const { nextDevices, entry, created } = planDeviceKeyFork([legacy], 'legacy', KEY_A, 'Mac', 9)
    expect(created).toBe(true)
    expect(nextDevices[0]).toBe(legacy)
    expect(entry).toMatchObject({
      scope: 'runtime',
      grants: ['desktop-control'],
      pairingReach: 'this-computer',
      credentialKind: 'device-key',
      devicePublicKeyB64: KEY_A,
      forkedFrom: 'legacy',
      callerFingerprint: devicePrincipalOf(legacy).callerFingerprint,
      lastSeenAt: 9
    })
    expect(entry.token).toBeUndefined()
    expect(entry.deviceId).not.toBe('legacy')
  })

  it('is idempotent per (token row, key) and gives each installation its own row', () => {
    const first = planDeviceKeyFork([tokenRow()], 'legacy', KEY_A, 'A', 1)
    const repeat = planDeviceKeyFork(first.nextDevices, 'legacy', KEY_A, 'A', 2)
    expect(repeat).toMatchObject({ created: false, entry: first.entry })
    const second = planDeviceKeyFork(first.nextDevices, 'legacy', KEY_B, 'B', 3)
    expect(second.created).toBe(true)
    expect(second.entry.deviceId).not.toBe(first.entry.deviceId)
  })

  it('refuses keyed rows, delegated children, unknown rows and a key bound elsewhere', () => {
    const fork = planDeviceKeyFork(
      [tokenRow(), tokenRow({ deviceId: 'other', token: 't2' })],
      'legacy',
      KEY_A,
      'A',
      1
    )
    expect(() => planDeviceKeyFork(fork.nextDevices, fork.entry.deviceId, KEY_B, 'x', 1)).toThrow(
      'device_already_keyed'
    )
    expect(() => planDeviceKeyFork(fork.nextDevices, 'other', KEY_A, 'x', 1)).toThrow(
      'device_key_in_use'
    )
    expect(() =>
      planDeviceKeyFork([tokenRow({ parentDeviceId: 'p' })], 'legacy', KEY_A, 'x', 1)
    ).toThrow('delegated_device')
    expect(() => planDeviceKeyFork([], 'legacy', KEY_A, 'x', 1)).toThrow('device_not_found')
  })

  it('commits nothing when the registry cannot be read', () => {
    const registry = new DeviceRegistry(mkdtempSync(join(tmpdir(), 'orca-device-key-fork-')))
    const legacy = registry.addDevice('Laptop', 'runtime')
    registry['registryUnreadable'] = true
    expect(() => registry.forkDeviceKey(legacy.deviceId, KEY_A, 'Mac')).toThrow()
    expect(registry.listDevices()).toHaveLength(1)
    expect(registry.lookupDeviceKey('anything')).toEqual({ kind: 'unavailable' })
  })

  it('keeps a corrupt registry aside and never calls an unlisted key revoked while it exists', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-fork-'))
    writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), '[{"deviceId":"keyed",')
    const afterCrash = new DeviceRegistry(userDataPath)
    expect(afterCrash.lookupDeviceKey('keyed')).toEqual({ kind: 'unavailable' })
    afterCrash.getOrCreatePendingDevice('Re-pair', 'mobile')
    expect(readdirSync(userDataPath).some((name) => name.includes('.corrupt-'))).toBe(true)

    const nextLaunch = new DeviceRegistry(userDataPath)
    expect(nextLaunch.listDevices()).toHaveLength(1)
    expect(nextLaunch.lookupDeviceKey('keyed')).toEqual({ kind: 'unavailable' })
  })

  it('stays doubtful when the rewrite after quarantine never landed', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-fork-'))
    writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), '{')
    writeFileSync(join(userDataPath, `${DEVICE_REGISTRY_FILENAME}.corrupt-1`), '{')
    rmSync(join(userDataPath, DEVICE_REGISTRY_FILENAME))
    expect(new DeviceRegistry(userDataPath).lookupDeviceKey('keyed')).toEqual({
      kind: 'unavailable'
    })
  })
})
