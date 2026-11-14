import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-device-authority-'))
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

it.each(['device', 'ancestor'] as const)(
  'never revives a captured authority after external %s removal and identical restoration',
  (removed) => {
    const registry = new DeviceRegistry(directory)
    const parent = registry.addDevice('Desktop', 'runtime')
    registry.updateLastSeen(parent.deviceId)
    const device =
      removed === 'device'
        ? parent
        : registry.forkDeviceKey(parent.deviceId, Buffer.alloc(32, 1).toString('base64'), 'Browser')
    const principal = {
      deviceId: device.deviceId,
      credentialRevision: device.credentialRevision ?? 0,
      ...(device.token ? { deviceToken: device.token } : {})
    }
    const authority = registry.captureAuthority(principal)!
    expect(authority.signal.aborted).toBe(false)
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const saved = readFileSync(path, 'utf8')
    const rows: { deviceId: string }[] = JSON.parse(saved)
    writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== parent.deviceId)))
    vi.advanceTimersByTime(1001)
    registry.refreshAuthority()
    expect(authority.signal.aborted).toBe(true)
    expect(registry.resolveAuthenticatedPrincipal(principal, authority)).toBeNull()

    writeFileSync(path, saved)
    vi.advanceTimersByTime(1001)
    registry.refreshAuthority()
    expect(registry.resolveAuthenticatedPrincipal(principal, authority)).toBeNull()
    const restored = registry.captureAuthority(principal)!
    expect(restored.signal.aborted).toBe(false)
    expect(restored.id).not.toBe(authority.id)
    expect(registry.resolveAuthenticatedPrincipal(principal, restored)?.deviceId).toBe(
      device.deviceId
    )
  }
)

it('preserves a captured authority through timestamp-only sightings and invalidates it on expiry', () => {
  const registry = new DeviceRegistry(directory)
  const paired = registry.addDevice('Saved desktop', 'runtime')
  const principal = { deviceId: paired.deviceId, credentialRevision: 0, deviceToken: paired.token }
  const authority = registry.captureAuthority(principal)!
  registry.updateLastSeen(paired.deviceId)
  registry.updateLastSeenDeferred(paired.deviceId)
  vi.advanceTimersByTime(1001)
  registry.refreshAuthority()
  expect(authority.signal.aborted).toBe(false)
  expect(registry.captureAuthority(principal)?.id).toBe(authority.id)

  const offer = registry.addDevice('Unused offer', 'runtime', 'network', [], 2000)
  const unused = registry.captureAuthority({
    deviceId: offer.deviceId,
    credentialRevision: 0,
    deviceToken: offer.token
  })!
  vi.advanceTimersByTime(2001)
  registry.refreshAuthority()
  expect(unused.signal.aborted).toBe(true)
  expect(authority.signal.aborted).toBe(false)
})

it('retires captured authority when its observer stops and permits a fresh incarnation', () => {
  const registry = new DeviceRegistry(directory)
  const device = registry.addDevice('Saved desktop', 'runtime')
  const principal = { deviceId: device.deviceId, credentialRevision: 0, deviceToken: device.token }
  const before = registry.captureAuthority(principal)!
  registry.retireCapturedAuthority()
  expect(before.signal.aborted).toBe(true)
  expect(registry.resolveAuthenticatedPrincipal(principal, before)).toBeNull()
  const after = registry.captureAuthority(principal)!
  expect(after.signal.aborted).toBe(false)
  expect(after.id).not.toBe(before.id)
  expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)
})
