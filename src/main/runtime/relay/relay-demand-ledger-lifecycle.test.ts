import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'
import { isMobileRelayAllowed } from '../../../shared/mobile-relay-policy'
import { RelayDemandLedger } from './relay-demand-ledger'
import { RelayRevokeOutbox, type RelayDeviceBinding } from './relay-revoke-outbox'

const ownerIdentityKey = 'user-1\0profile-1\0org-1'
const otherOwnerIdentityKey = 'user-2\0profile-2\0org-2'
const relayHostId = 'relay-host-1'

/** Mirrors DesktopRelayService.isRelayAllowedForDevice: a live pull, not a snapshot. */
function fixture(now = 1_000) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-demand-lifecycle-'))
  const deviceRegistry = new DeviceRegistry(userDataPath)
  const revokeOutbox = new RelayRevokeOutbox(userDataPath)
  const host = { mode: 'automatic' as MobilePairingConnectionMode }
  const ledger = new RelayDemandLedger({
    deviceRegistry,
    revokeOutbox,
    relayHostId,
    now: () => now,
    isRelayAllowedForDevice: (deviceId) =>
      isMobileRelayAllowed({
        hostConnectionMode: host.mode,
        deviceConnectionMode: deviceRegistry.getMobilePairingConnectionMode(deviceId) ?? null
      })
  })
  return { userDataPath, deviceRegistry, revokeOutbox, ledger, host }
}

function binding(relayDeviceId: string, inviteExpiresAt?: number): RelayDeviceBinding {
  return { relayDeviceId, relayHostId, ownerIdentityKey, inviteExpiresAt }
}

function pairedPhone(fx: ReturnType<typeof fixture>, name = 'Phone') {
  const phone = fx.deviceRegistry.addDevice(name)
  fx.deviceRegistry.setMobilePairingConnectionMode(phone.deviceId, 'automatic')
  fx.deviceRegistry.setRelayBinding(phone.deviceId, binding(phone.deviceId))
  fx.deviceRegistry.updateLastSeen(phone.deviceId)
  return phone.deviceId
}

describe('RelayDemandLedger transient-ref lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  // Hazard 1: the live policy flips between acquire and release.
  it('releases a ref acquired before a policy flip instead of leaking it', () => {
    const fx = fixture()
    const deviceId = pairedPhone(fx)
    const release = fx.ledger.acquireTransient(`endpoints:${deviceId}`, deviceId)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)

    fx.host.mode = 'local-only'
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)

    // The release path must be policy-blind, or the ref is unreachable forever.
    release()
    expect(fx.ledger.transientRefsForTests().size).toBe(0)

    fx.host.mode = 'automatic'
    // Standing binding demand returns; the released ref must not add a second pin.
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)
    fx.deviceRegistry.removeDevice(deviceId)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })

  it('restores a held ref as demand when the policy flips back', () => {
    const fx = fixture()
    const deviceId = pairedPhone(fx)
    fx.deviceRegistry.removeDevice(deviceId)
    const release = fx.ledger.acquireTransient(`pairing:${deviceId}`, deviceId)

    fx.host.mode = 'local-only'
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)
    // The filter must be re-evaluated per call, not baked in at acquire time.
    fx.host.mode = 'automatic'
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)
    release()
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })

  // Hazard 2: the same release closure invoked repeatedly.
  it('a repeated release does not decrement a count another holder still owns', () => {
    const fx = fixture()
    const deviceId = pairedPhone(fx)
    fx.deviceRegistry.removeDevice(deviceId)
    const key = `endpoints:${deviceId}`
    const releaseFirst = fx.ledger.acquireTransient(key, deviceId)
    const releaseSecond = fx.ledger.acquireTransient(key, deviceId)
    expect(fx.ledger.transientRefsForTests().get(key)?.count).toBe(2)

    releaseFirst()
    releaseFirst()
    releaseFirst()
    expect(fx.ledger.transientRefsForTests().get(key)?.count).toBe(1)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)

    releaseSecond()
    expect(fx.ledger.transientRefsForTests().size).toBe(0)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)
  })

  it('a stale release from a finished ref does not cancel a later acquire of the same key', () => {
    const fx = fixture()
    const deviceId = pairedPhone(fx)
    fx.deviceRegistry.removeDevice(deviceId)
    const key = `provision:${deviceId}`
    const stale = fx.ledger.acquireTransient(key, deviceId)
    stale()
    expect(fx.ledger.transientRefsForTests().size).toBe(0)

    const fresh = fx.ledger.acquireTransient(key, deviceId)
    stale()
    expect(fx.ledger.transientRefsForTests().get(key)?.count).toBe(1)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)
    fresh()
    expect(fx.ledger.transientRefsForTests().size).toBe(0)
  })

  // Hazard 3: an operation throws and its ref is never released.
  it('an unreleased ref pins demand and retains its map entry', () => {
    const fx = fixture()
    const deviceId = pairedPhone(fx)
    fx.deviceRegistry.removeDevice(deviceId)
    for (let index = 0; index < 5; index += 1) {
      fx.ledger.acquireTransient(`pairing:abandoned-${index}`, `abandoned-${index}`)
    }
    expect(fx.ledger.transientRefsForTests().size).toBe(5)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)
  })

  // Hazard 4: two refs for one device released in the opposite order.
  it('is release-order independent for refs sharing a key', () => {
    const fx = fixture()
    const deviceId = pairedPhone(fx)
    fx.deviceRegistry.removeDevice(deviceId)
    const key = `endpoints:${deviceId}`
    const outer = fx.ledger.acquireTransient(key, deviceId)
    const inner = fx.ledger.acquireTransient(key, deviceId)
    inner()
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)
    const middle = fx.ledger.acquireTransient(key, deviceId)
    outer()
    expect(fx.ledger.transientRefsForTests().get(key)?.count).toBe(1)
    middle()
    expect(fx.ledger.transientRefsForTests().size).toBe(0)
  })

  // Hazard 5: a release for device B must not disturb device A's ref.
  it('keeps per-device refs independent across a concurrent release', () => {
    const fx = fixture()
    const deviceA = fx.deviceRegistry.addDevice('Phone A').deviceId
    const deviceB = fx.deviceRegistry.addDevice('Phone B').deviceId
    fx.deviceRegistry.setMobilePairingConnectionMode(deviceA, 'local-only')
    fx.deviceRegistry.setMobilePairingConnectionMode(deviceB, 'automatic')

    const releaseA = fx.ledger.acquireTransient(`pairing:${deviceA}`, deviceA)
    const releaseB = fx.ledger.acquireTransient(`pairing:${deviceB}`, deviceB)
    // A is excluded by its own pair-time mode; B alone carries the demand.
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)

    releaseB()
    expect(fx.ledger.transientRefsForTests().size).toBe(1)
    expect(fx.ledger.transientRefsForTests().get(`pairing:${deviceA}`)?.deviceId).toBe(deviceA)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)

    releaseA()
    expect(fx.ledger.transientRefsForTests().size).toBe(0)
  })

  // Hazard 6: the ledger owns no timers, so teardown is the caller's map only.
  it('arms no timers of its own across acquire, query and release', () => {
    vi.useFakeTimers()
    const fx = fixture()
    const deviceId = pairedPhone(fx)
    fx.deviceRegistry.setRelayBinding(deviceId, binding(deviceId, 2_000))
    const release = fx.ledger.acquireTransient(`pairing:${deviceId}`, deviceId)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)
    expect(fx.ledger.nextPendingExpiry()).toBe(2_000)
    release()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('RelayDemandLedger nextPendingExpiry scoping', () => {
  it('ignores a pending invite bound to a different relay host', () => {
    const fx = fixture()
    const phone = fx.deviceRegistry.addDevice('Foreign-host phone')
    fx.deviceRegistry.setRelayBinding(phone.deviceId, {
      ...binding(phone.deviceId, 2_000),
      relayHostId: 'relay-host-2'
    })
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)
    expect(fx.ledger.nextPendingExpiry()).toBeNull()
  })

  it('ignores a pending invite on a non-mobile device', () => {
    const fx = fixture()
    const runtime = fx.deviceRegistry.addDevice('Runtime', 'runtime')
    fx.deviceRegistry.setRelayBinding(runtime.deviceId, binding(runtime.deviceId, 2_000))
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)
    expect(fx.ledger.nextPendingExpiry()).toBeNull()
  })

  it('ignores a pending invite the live policy excludes, and re-arms when it flips back', () => {
    const fx = fixture()
    const phone = fx.deviceRegistry.addDevice('LAN phone')
    fx.deviceRegistry.setMobilePairingConnectionMode(phone.deviceId, 'automatic')
    fx.deviceRegistry.setRelayBinding(phone.deviceId, binding(phone.deviceId, 2_000))
    expect(fx.ledger.nextPendingExpiry()).toBe(2_000)

    fx.host.mode = 'local-only'
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(false)
    expect(fx.ledger.nextPendingExpiry()).toBeNull()

    fx.host.mode = 'automatic'
    expect(fx.ledger.nextPendingExpiry()).toBe(2_000)
  })

  it('still reports the nearest in-scope pending invite', () => {
    const fx = fixture()
    const near = fx.deviceRegistry.addDevice('Near phone')
    const far = fx.deviceRegistry.addDevice('Far phone')
    fx.deviceRegistry.setRelayBinding(far.deviceId, binding(far.deviceId, 9_000))
    fx.deviceRegistry.setRelayBinding(near.deviceId, binding(near.deviceId, 4_000))
    expect(fx.ledger.nextPendingExpiry()).toBe(4_000)
  })
})

describe('RelayDemandLedger owner scoping of transient refs', () => {
  // Characterisation: transient refs carry no owner identity, so they answer
  // hasDemand for any signed-in identity. See the report for the risk window.
  it('counts a transient ref for an identity that did not request it', () => {
    const fx = fixture()
    const phone = fx.deviceRegistry.addDevice('Phone')
    fx.deviceRegistry.setMobilePairingConnectionMode(phone.deviceId, 'automatic')
    fx.deviceRegistry.setRelayBinding(phone.deviceId, binding(phone.deviceId))
    const release = fx.ledger.acquireTransient(`pairing:${phone.deviceId}`, phone.deviceId)
    expect(fx.ledger.hasDemand(ownerIdentityKey)).toBe(true)
    expect(fx.ledger.hasDemand(otherOwnerIdentityKey)).toBe(true)
    release()
    expect(fx.ledger.hasDemand(otherOwnerIdentityKey)).toBe(false)
  })
})
