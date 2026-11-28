import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'

it('round-trips activity leases and cannot restore them after the phone is revoked', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-live-activity-'))
  try {
    const registry = new DeviceRegistry(directory)
    const phone = registry.addDevice('Phone', 'mobile')
    const lease = {
      activityId: 'activity',
      schemaVersion: 2 as const,
      overviewId: '11111111-1111-4111-8111-111111111111',
      scopeKey: 'a'.repeat(64),
      sequence: 7,
      showNames: false,
      expiresAt: 1_900_000_000_000,
      credentialRevision: 0
    }
    registry.setLiveActivities(phone.deviceId, [lease])
    const restored = new DeviceRegistry(directory)
    expect(restored.getDevice(phone.deviceId)?.liveActivities).toEqual([
      {
        activityId: 'activity',
        schemaVersion: 2,
        overviewId: '11111111-1111-4111-8111-111111111111',
        scopeKey: 'a'.repeat(64),
        sequence: 7,
        showNames: false,
        expiresAt: 1_900_000_000_000,
        credentialRevision: 0
      }
    ])
    registry.removeDevice(phone.deviceId)
    expect(restored.setLiveActivities(phone.deviceId, [lease])).toBe(false)
    expect(new DeviceRegistry(directory).listDevices()).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
