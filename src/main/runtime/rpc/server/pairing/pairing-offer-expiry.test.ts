import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import './device-entry'

import './mobile-pairing-files'

const TTL = 10 * 60_000
let dir: string

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  dir = mkdtempSync(join(tmpdir(), 'orca-offer-expiry-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('DeviceRegistry pairing offer TTL', () => {
  it('reuses an offer with time left and mints a fresh one inside the last minute', () => {
    const registry = new DeviceRegistry(dir)
    const first = registry.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    expect(first.offerExpiresAt).toBe(1_000_000 + TTL)

    vi.setSystemTime(1_000_000 + TTL - 61_000)
    expect(registry.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL).deviceId).toBe(
      first.deviceId
    )

    vi.setSystemTime(1_000_000 + TTL - 60_000)
    const fresh = registry.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    expect(fresh.deviceId).not.toBe(first.deviceId)
    // A phone mid-scan of the old code still pairs until that code's own expiry.
    expect(registry.validateToken(first.token)?.deviceId).toBe(first.deviceId)

    vi.setSystemTime(1_000_000 + TTL)
    expect(registry.validateToken(first.token)).toBeNull()
    registry.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    expect(registry.getDevice(first.deviceId)).toBeNull()
    expect(registry.getDevice(fresh.deviceId)).not.toBeNull()
  })

  it('retries a failed first-seen persist so the device survives a restart after expiry', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(1_000_000)
    const registry = new DeviceRegistry(dir)
    const offer = registry.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    const save = registry['save'].bind(registry)
    registry['save'] = vi.fn(() => {
      throw new Error('EPERM')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => registry.updateLastSeen(offer.deviceId)).toThrow('EPERM')
    // Still failing on the first retry: keep retrying.
    vi.advanceTimersByTime(60_000)
    registry['save'] = save
    vi.advanceTimersByTime(60_000)

    vi.setSystemTime(1_000_000 + TTL + 1)
    const restarted = new DeviceRegistry(dir)
    expect(restarted.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
    restarted.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    expect(restarted.getDevice(offer.deviceId)).not.toBeNull()
  })

  it('keeps a paired row paired when a stale writer saves its older copy', () => {
    const owner = new DeviceRegistry(dir)
    const offer = owner.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    // Loaded while the offer was still unscanned.
    const stale = new DeviceRegistry(dir)
    vi.setSystemTime(1_000_000 + 1_000)
    owner.updateLastSeen(offer.deviceId)

    stale.addDevice('CLI', 'runtime')
    vi.setSystemTime(9e12)
    expect(new DeviceRegistry(dir).validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
  })
})
