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
      token: 'aabb',
      apnsEnvironment: 'sandbox' as const,
      worktreeId: 'folder:workspace',
      paneKey: 'pane',
      showNames: false,
      expiresAt: 1_900_000_000_000,
      credentialRevision: 0
    }
    registry.setLiveActivities(phone.deviceId, [lease])
    const restored = new DeviceRegistry(directory)
    expect(restored.getDevice(phone.deviceId)?.liveActivities).toEqual([
      {
        activityId: 'activity',
        token: 'aabb',
        apnsEnvironment: 'sandbox',
        worktreeId: 'folder:workspace',
        paneKey: 'pane',
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
