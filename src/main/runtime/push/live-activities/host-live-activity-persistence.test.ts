import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import { HostLiveActivities } from './host-live-activities'

const registration = {
  activityId: 'activity',
  schemaVersion: 2 as const,
  overviewId: '33333333-3333-4333-8333-333333333333',
  scopeKey: 'a'.repeat(64),
  showNames: false
}
function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(20_000)
  const directory = mkdtempSync(join(tmpdir(), 'orca-activity-persistence-'))
  const registry = new DeviceRegistry(directory)
  const phone = registry.addDevice('Phone', 'mobile')
  const host = new HostLiveActivities(
    {
      listAllMobileSessionTabsInventory: async () => ({ snapshots: [], authoritative: true }),
      projectLocalAgentSessionTabs: (frame) => ({ frame, complete: true }),
      restoreStructuredAgentSessionTabs: async () => {},
      onMobileSessionTabsChanged: () => () => {}
    },
    registry,
    { registerLiveActivityOverview: async () => true, sendLiveActivity: async () => 'sent' }
  )
  return {
    directory,
    registry,
    phone,
    host,
    close: () => {
      host.stop()
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

it('does not acknowledge removal until the saved lease can be deleted durably', async () => {
  const f = fixture()
  try {
    expect(await f.host.register(f.phone.deviceId, registration)).toEqual({ registered: true })
    const fault = vi.spyOn(f.registry, 'setLiveActivities').mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })
    expect(() => f.host.unregister(f.phone.deviceId, 'activity')).toThrow('disk unavailable')
    fault.mockRestore()
    expect(
      new DeviceRegistry(f.directory)
        .getDevice(f.phone.deviceId)
        ?.liveActivities?.map((lease) => lease.activityId)
    ).toEqual(['activity'])
    f.host.unregister(f.phone.deviceId, 'activity')
    expect(new DeviceRegistry(f.directory).getDevice(f.phone.deviceId)?.liveActivities).toEqual([])
  } finally {
    f.close()
  }
})

it('counts unexpired saved leases outside the tracked credential revision before accepting another', async () => {
  const f = fixture()
  try {
    const leases = ['a', 'b', 'c', 'd'].map((activityId) => ({
      ...registration,
      activityId,
      expiresAt: 80_000,
      credentialRevision: 99,
      sequence: 0
    }))
    f.registry.setLiveActivities(f.phone.deviceId, leases)
    f.host.restore()
    expect(await f.host.register(f.phone.deviceId, registration)).toEqual({ registered: false })
    expect(
      new DeviceRegistry(f.directory)
        .getDevice(f.phone.deviceId)
        ?.liveActivities?.map((lease) => lease.activityId)
    ).toEqual(['a', 'b', 'c', 'd'])
  } finally {
    f.close()
  }
})
