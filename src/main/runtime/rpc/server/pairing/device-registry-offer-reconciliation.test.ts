import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as secureFile from '../../../../../shared/secure-storage/secure-file'
import type { DeviceEntry } from './device-entry'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-offer-reconciliation-'))
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})
const replacement = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

it.each(['failed first sighting', 'paired sighting'] as const)(
  'an external expiry/reset defeats a stale %s',
  (stage) => {
    const registry = new DeviceRegistry(directory)
    const device = registry.addDevice('Desktop', 'runtime', 'network', [], 5000)
    const authority = registry.captureAuthority({
      deviceId: device.deviceId,
      credentialRevision: 0,
      deviceToken: device.token
    })!
    if (stage === 'failed first sighting') {
      vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      expect(() => registry.updateLastSeen(device.deviceId)).toThrowError(
        expect.objectContaining({ code: 'registry_unavailable' })
      )
    } else {
      registry.updateLastSeen(device.deviceId)
      vi.setSystemTime(2000)
      registry.updateLastSeenDeferred(device.deviceId)
    }
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const rows: DeviceEntry[] = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(
      path,
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          lastSeenAt: 0,
          ticketFirstSeenAt: undefined,
          offerExpiresAt: 900
        }))
      )
    )
    vi.advanceTimersByTime(1001)
    registry.refreshAuthority()
    registry.flushPendingLastSeen()
    expect(registry.validateToken(device.token)).toBeNull()
    expect(authority.signal.aborted).toBe(true)
    expect(new DeviceRegistry(directory).validateToken(device.token)).toBeNull()
  }
)

it.each([600999, 601001])(
  'keeps a valid concurrent first sighting and its original exchange window at %i',
  (at) => {
    const registry = new DeviceRegistry(directory)
    const device = registry.addDevice('Desktop', 'runtime', 'network', [], 1000)
    const writer = new DeviceRegistry(directory)
    vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => registry.updateLastSeen(device.deviceId)).toThrowError(
      expect.objectContaining({ code: 'registry_unavailable' })
    )
    vi.setSystemTime(1500)
    writer.updateLastSeen(device.deviceId)
    vi.setSystemTime(3000)
    registry.updateLastSeen(device.deviceId)
    expect(new DeviceRegistry(directory).validateToken(device.token)?.deviceId).toBe(
      device.deviceId
    )
    vi.setSystemTime(at)
    if (at === 600999) {
      registry.exchangePairingTicket(device.deviceId, device.token, replacement)
      expect(registry.validateToken(replacement)?.deviceId).toBe(device.deviceId)
      expect(registry.validateToken(device.token)).toBeNull()
    } else {
      expect(() =>
        registry.exchangePairingTicket(device.deviceId, device.token, replacement)
      ).toThrow('ticket_window_closed')
      expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)
      expect(registry.validateToken(replacement)).toBeNull()
    }
  }
)

it('retains last-good rows through a malformed edit, refuses writes and recovers on a valid snapshot', () => {
  const registry = new DeviceRegistry(directory)
  const device = registry.addDevice('Desktop', 'runtime')
  registry.updateLastSeen(device.deviceId)
  const path = join(directory, DEVICE_REGISTRY_FILENAME)
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, '[{"deviceId":')
  vi.advanceTimersByTime(1001)
  registry.refreshAuthority()
  expect(registry.getDevice(device.deviceId)?.token).toBe(device.token)
  expect(() => registry.validateToken(device.token)).toThrowError(
    expect.objectContaining({ code: 'registry_unavailable' })
  )
  expect(() => registry.addDevice('Not published', 'runtime')).toThrowError(
    expect.objectContaining({ code: 'registry_unavailable' })
  )
  expect(readFileSync(path, 'utf8')).toBe('[{"deviceId":')
  writeFileSync(path, original)
  vi.advanceTimersByTime(1001)
  registry.refreshAuthority()
  expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)
  const added = registry.addDevice('Later request', 'runtime')
  expect(registry.validateToken(added.token)?.deviceId).toBe(added.deviceId)
})
