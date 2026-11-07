import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

function registryWith(rows: unknown[]): { userDataPath: string; registry: DeviceRegistry } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-registry-read-'))
  writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), JSON.stringify(rows))
  return { userDataPath, registry: new DeviceRegistry(userDataPath) }
}

const goodRow = {
  deviceId: 'good',
  name: 'Phone',
  token: 'good-token',
  scope: 'mobile',
  pairedAt: 1,
  lastSeenAt: 2
}

describe('device registry load validation', () => {
  it('keeps a row whose token is not a string listed but unable to authenticate', () => {
    const { registry } = registryWith([goodRow, { ...goodRow, deviceId: 'bad-token', token: 7 }])
    expect(registry.listDevices().map((device) => device.deviceId)).toEqual(['good', 'bad-token'])
    expect(registry.getDevice('bad-token')?.token).toBeUndefined()
    expect(registry.validateToken('good-token')?.deviceId).toBe('good')
  })

  it('drops a row without a string deviceId and sets the file aside before rewriting', () => {
    const { userDataPath, registry } = registryWith([
      goodRow,
      { ...goodRow, deviceId: 42, token: 'orphan-token' },
      { ...goodRow, deviceId: undefined, token: 'missing-id-token' }
    ])
    expect(registry.listDevices().map((device) => device.deviceId)).toEqual(['good'])
    expect(registry.validateToken('orphan-token')).toBeNull()
    expect(registry.lookupDeviceKey('42')).toEqual({ kind: 'unavailable' })
    registry.getOrCreatePendingDevice('Re-pair', 'mobile')
    expect(readdirSync(userDataPath).some((name) => name.includes('.corrupt-'))).toBe(true)
  })
})
