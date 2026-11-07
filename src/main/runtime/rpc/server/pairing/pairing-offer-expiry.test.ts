import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { findTokenDevice, type DeviceEntry } from './device-entry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

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

function row(overrides: Partial<DeviceEntry>): DeviceEntry {
  return {
    deviceId: 'd1',
    name: 'Phone',
    token: 'tok',
    scope: 'mobile',
    pairedAt: 0,
    lastSeenAt: 0,
    ...overrides
  }
}

describe('findTokenDevice offer expiry', () => {
  it('refuses an expired unscanned offer unless it was seen this session', () => {
    const devices = [row({ offerExpiresAt: 500 })]
    expect(findTokenDevice(devices, 'tok', new Set(), 500)).toBeNull()
    expect(findTokenDevice(devices, 'tok', new Set(['d1']), 500)?.deviceId).toBe('d1')
  })

  it('never expires paired rows or rows without an expiry', () => {
    expect(
      findTokenDevice([row({ lastSeenAt: 1, offerExpiresAt: 1 })], 'tok', new Set(), 9e9)
    ).not.toBeNull()
    expect(findTokenDevice([row({})], 'tok', new Set(), 9e9)).not.toBeNull()
  })
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

  it('leaves headless offers untouched: no expiry, and expiring offers are never reused', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network', [], TTL)
    const headless = registry.getOrCreatePendingDevice('CLI', 'runtime')
    expect(headless.deviceId).not.toBe(desktop.deviceId)
    expect(headless.offerExpiresAt).toBeUndefined()

    vi.setSystemTime(9e12)
    expect(registry.validateToken(headless.token)?.deviceId).toBe(headless.deviceId)
    expect(registry.getOrCreatePendingDevice('CLI', 'runtime').deviceId).toBe(headless.deviceId)
  })

  it('keeps a client that authenticated in time even when the first-seen persist fails', () => {
    const registry = new DeviceRegistry(dir)
    const offer = registry.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    const save = registry['save'].bind(registry)
    registry['save'] = vi.fn(() => {
      throw new Error('disk full')
    })
    expect(() => registry.updateLastSeen(offer.deviceId)).toThrow('disk full')
    registry['save'] = save

    vi.setSystemTime(1_000_000 + TTL + 1)
    expect(registry.validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
    registry.getOrCreatePendingDevice('Phone', 'mobile', 'network', [], TTL)
    expect(registry.getDevice(offer.deviceId)).not.toBeNull()
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

  it('round-trips the expiry through disk and drops it on first sighting', () => {
    const offer = new DeviceRegistry(dir).getOrCreatePendingDevice(
      'Phone',
      'mobile',
      'network',
      [],
      TTL
    )
    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.getDevice(offer.deviceId)?.offerExpiresAt).toBe(1_000_000 + TTL)

    reloaded.updateLastSeen(offer.deviceId)
    const onDisk = JSON.parse(readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf8'))
    expect(onDisk[0]).not.toHaveProperty('offerExpiresAt')
    vi.setSystemTime(9e12)
    expect(new DeviceRegistry(dir).validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
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

  it('treats an unreadable expiry as never expiring', () => {
    writeFileSync(
      join(dir, DEVICE_REGISTRY_FILENAME),
      JSON.stringify([{ ...row({}), offerExpiresAt: 'soon' }])
    )
    vi.setSystemTime(9e12)
    expect(new DeviceRegistry(dir).validateToken('tok')?.deviceId).toBe('d1')
  })
})
