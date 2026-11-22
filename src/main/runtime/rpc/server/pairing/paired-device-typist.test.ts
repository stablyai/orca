import { describe, expect, it } from 'vitest'
import type { DeviceEntry } from './device-entry'
import { planDelegatedMobileDevices } from './delegated-mobile-devices'
import { pairedDeviceTypistOf } from './paired-device-typist'

const row = (
  fields: Partial<DeviceEntry> & Pick<DeviceEntry, 'deviceId' | 'name'>
): DeviceEntry => ({
  scope: 'runtime',
  pairedAt: 1,
  lastSeenAt: 1,
  ...fields
})

const sam = { id: 'acct-sam', name: 'Sam Lee', computer: "Sam's MacBook Pro" }
const owner = { id: 'acct-owner', name: 'Jin', computer: 'Studio Mac' }
// One paired row both desktops share; the owner declared last.
const shared = row({ deviceId: 'shared', name: 'Runtime 11/17/2026', orcaAccount: owner })
const claims = new Map<string, { id: string; name: string; computer?: string }>([
  ['sam-install', sam],
  ['owner-install', owner]
])

function typist(rows: DeviceEntry[], id: string, connectionClaim: typeof sam | null = null) {
  const byId = new Map(rows.map((device) => [device.deviceId, device]))
  return pairedDeviceTypistOf(
    id,
    (deviceId) => byId.get(deviceId) ?? null,
    connectionClaim,
    (ownerId, instance) => (ownerId === 'shared' ? (claims.get(instance) ?? null) : null)
  )
}

describe('who typed a paired device message', () => {
  it("names a desktop by its own connection's claim, never the shared row's", () => {
    expect(typist([shared], 'shared', sam)).toEqual(sam)
    expect(typist([shared], 'shared', null)).toBeNull()
  })

  it('names a phone a shared row relays by the installation that synced it', () => {
    const { nextDevices } = planDelegatedMobileDevices(
      [shared],
      shared,
      [{ phoneKey: 'sam-phone', name: "iPhone via Sam's MacBook Pro" }],
      'sam-install'
    )
    const phone = nextDevices.find((device) => device.phoneKey === 'sam-phone')!
    expect(typist(nextDevices, phone.deviceId)).toEqual({ ...sam, phone: 'iPhone' })
  })

  it('names a phone paired from an offer by the installation whose terminal minted it', () => {
    const minted = row({
      deviceId: 'pixel',
      name: 'Pixel',
      scope: 'mobile',
      createdByDeviceId: 'shared',
      originClientInstanceId: 'sam-install'
    })
    expect(typist([shared, minted], 'pixel')).toEqual({ ...sam, phone: 'Pixel' })
  })

  it('names nobody for a phone whose installation is unknown or offline', () => {
    const legacy = row({
      deviceId: 'old',
      name: 'iPhone via X',
      scope: 'mobile',
      parentDeviceId: 'shared'
    })
    const offline = { ...legacy, deviceId: 'off', originClientInstanceId: 'gone' }
    expect(typist([shared, legacy, offline], 'old')).toBeNull()
    expect(typist([shared, offline], 'off')).toBeNull()
  })

  it("keeps the relayed phone's own name when the relay named a different computer", () => {
    const claimed = { id: 'acct-sam', name: 'Sam Lee' }
    claims.set('legacy-install', claimed)
    const phone = row({
      deviceId: 'p',
      name: "iPhone via Sam's MacBook Pro",
      scope: 'mobile',
      parentDeviceId: 'shared',
      originClientInstanceId: 'legacy-install'
    })
    expect(typist([shared, phone], 'p')).toEqual({ ...claimed, phone: 'iPhone' })
  })
})
