import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import type { DeviceEntry } from './device-entry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-external-authority-'))
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

function pairedRegistries() {
  const writer = new DeviceRegistry(directory)
  const parent = writer.addDevice('Desktop', 'runtime')
  writer.updateLastSeen(parent.deviceId)
  const child = writer.forkDeviceKey(
    parent.deviceId,
    Buffer.alloc(32, 7).toString('base64'),
    'Browser'
  )
  return { writer, observer: new DeviceRegistry(directory), parent, child }
}

it.each(['device', 'ancestor'] as const)(
  'retires live %s authority after another registry promotes its pairing ticket, including restoration',
  (target) => {
    const { writer, observer, parent, child } = pairedRegistries()
    const device = target === 'device' ? parent : child
    const principal = {
      deviceId: device.deviceId,
      credentialRevision: device.credentialRevision ?? 0,
      ...(device.token ? { deviceToken: device.token } : {})
    }
    expect(child.deviceId).not.toBe(parent.deviceId)
    expect(observer.lookupDeviceKey(child.deviceId)).toMatchObject({ kind: 'found' })
    const authority = observer.captureAuthority(principal)!
    expect(authority.signal.aborted).toBe(false)
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const original = readFileSync(path, 'utf8')

    writer.exchangePairingTicket(parent.deviceId, parent.token, 'replacement-device-token')
    expect(writer.validateToken('replacement-device-token')).toMatchObject({
      deviceId: parent.deviceId,
      credentialRevision: 1
    })
    vi.advanceTimersByTime(1001)
    observer.refreshAuthority()

    expect(authority.signal.aborted).toBe(true)
    expect(observer.resolveAuthenticatedPrincipal(principal, authority)).toBeNull()
    expect(observer.validateToken(parent.token)).toBeNull()
    expect(observer.validateToken('replacement-device-token')?.deviceId).toBe(parent.deviceId)
    const replacementPrincipal =
      target === 'device'
        ? { ...principal, credentialRevision: 1, deviceToken: 'replacement-device-token' }
        : principal
    const replacement = observer.captureAuthority(replacementPrincipal)!
    expect(replacement.signal.aborted).toBe(false)
    expect(observer.lookupDeviceKey(child.deviceId)).toMatchObject({ kind: 'found' })

    writeFileSync(path, original)
    vi.advanceTimersByTime(1001)
    observer.refreshAuthority()

    expect(authority.signal.aborted).toBe(true)
    expect(replacement.signal.aborted).toBe(true)
    expect(observer.resolveAuthenticatedPrincipal(principal, authority)).toBeNull()
    expect(observer.validateToken('replacement-device-token')).toBeNull()
    expect(observer.validateToken(parent.token)?.deviceId).toBe(parent.deviceId)
    const restored = observer.captureAuthority(principal)!
    expect(restored.signal.aborted).toBe(false)
    expect(observer.resolveAuthenticatedPrincipal(principal, restored)?.deviceId).toBe(
      device.deviceId
    )
  }
)

it('does not overwrite an external token promotion when a stale registry flushes a sighting', () => {
  const { writer, observer, parent } = pairedRegistries()
  const authority = observer.captureAuthority({
    deviceId: parent.deviceId,
    credentialRevision: 0,
    deviceToken: parent.token
  })!
  observer.updateLastSeen(parent.deviceId)
  observer.updateLastSeenDeferred(parent.deviceId)

  writer.exchangePairingTicket(parent.deviceId, parent.token, 'replacement-device-token')
  expect(writer.validateToken('replacement-device-token')?.deviceId).toBe(parent.deviceId)
  observer.flushPendingLastSeen()

  expect(authority.signal.aborted).toBe(true)
  expect(observer.validateToken(parent.token)).toBeNull()
  expect(observer.validateToken('replacement-device-token')?.deviceId).toBe(parent.deviceId)
  const reloaded = new DeviceRegistry(directory)
  expect(reloaded.validateToken(parent.token)).toBeNull()
  expect(reloaded.validateToken('replacement-device-token')).toMatchObject({
    deviceId: parent.deviceId,
    credentialRevision: 1
  })
})

it.each(['parentDeviceId', 'forkedFrom'] as const)(
  'observes a changed %s on the same child row and never revives its old authority',
  (field) => {
    const { observer, child } = pairedRegistries()
    const principal = { deviceId: child.deviceId, credentialRevision: 0 }
    const authority = observer.captureAuthority(principal)!
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const original = readFileSync(path, 'utf8')
    const rows: DeviceEntry[] = JSON.parse(original)
    writeFileSync(
      path,
      JSON.stringify(
        rows.map((row) =>
          row.deviceId === child.deviceId ? { ...row, [field]: 'missing-ancestor' } : row
        )
      )
    )
    expect(new DeviceRegistry(directory).lookupDeviceKey(child.deviceId)).toEqual({
      kind: 'refused'
    })
    vi.advanceTimersByTime(1001)
    observer.refreshAuthority()

    expect(authority.signal.aborted).toBe(true)
    expect(observer.captureAuthority(principal)).toBeNull()
    expect(observer.lookupDeviceKey(child.deviceId)).toEqual({ kind: 'refused' })
    writeFileSync(path, original)
    vi.advanceTimersByTime(1001)
    observer.refreshAuthority()

    expect(observer.resolveAuthenticatedPrincipal(principal, authority)).toBeNull()
    const restored = observer.captureAuthority(principal)!
    expect(restored.signal.aborted).toBe(false)
    expect(observer.resolveAuthenticatedPrincipal(principal, restored)?.deviceId).toBe(
      child.deviceId
    )
    expect(observer.lookupDeviceKey(child.deviceId)).toMatchObject({ kind: 'found' })
  }
)
