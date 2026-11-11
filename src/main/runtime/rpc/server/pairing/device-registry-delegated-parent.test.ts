// Removing a desktop on disk (or by any path short of revokeRuntimeAccess) must also stop the
// phones it delegated: their rows can outlive it, so auth checks the parent.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-parent-'))
  vi.useFakeTimers({ toFake: ['performance'] })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function removeOnDisk(deviceId: string): void {
  const path = join(dir, DEVICE_REGISTRY_FILENAME)
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
  // Another process's edit is seen once the registry's one-second stat window has passed.
  vi.advanceTimersByTime(1000)
}

function delegatedRegistry() {
  const registry = new DeviceRegistry(dir)
  const desktop = registry.addDevice('desktop', 'runtime')
  registry.updateLastSeen(desktop.deviceId)
  const [child] = registry.upsertDelegatedMobileDevices(desktop, [
    { phoneKey: 'phone-1', name: 'Pixel' }
  ])
  if (!child) {
    throw new Error('expected a delegated child')
  }
  const principal = {
    deviceId: child.deviceId,
    credentialRevision: child.credentialRevision ?? 0,
    deviceToken: child.token
  }
  return { registry, desktop, child, principal }
}

describe('delegated phone auth follows its parent desktop', () => {
  it('refuses it once an admin removes the desktop on disk', () => {
    const { registry, desktop, child, principal } = delegatedRegistry()

    removeOnDisk(desktop.deviceId)

    expect(registry.validateToken(child.token)).toBeNull()
    expect(registry.resolveAuthenticatedPrincipal(principal)).toBeNull()
  })

  it.each(['mobile', 'runtime'] as const)(
    'refuses a %s fork and its delegated phones after the bearer parent disappears on disk',
    (scope) => {
      const registry = new DeviceRegistry(dir)
      const parent = registry.addDevice('Parent', scope)
      registry.updateLastSeen(parent.deviceId)
      const fork = registry.forkDeviceKey(
        parent.deviceId,
        Buffer.alloc(32, 1).toString('base64'),
        'Migrated installation'
      )
      const children =
        scope === 'runtime'
          ? registry.upsertDelegatedMobileDevices(fork, [{ phoneKey: 'phone', name: 'Pixel' }])
          : []
      const principal = { deviceId: fork.deviceId, credentialRevision: 0 }
      expect(registry.lookupDeviceKey(fork.deviceId)).toMatchObject({ kind: 'found' })
      expect(registry.resolveAuthenticatedPrincipal(principal)?.deviceId).toBe(fork.deviceId)
      for (const child of children) {
        expect(registry.validateToken(child.token)?.deviceId).toBe(child.deviceId)
      }

      removeOnDisk(parent.deviceId)

      expect(registry.lookupDeviceKey(fork.deviceId)).toEqual({ kind: 'refused' })
      expect(registry.resolveAuthenticatedPrincipal(principal)).toBeNull()
      for (const child of children) {
        expect(registry.validateToken(child.token)).toBeNull()
        expect(
          registry.resolveAuthenticatedPrincipal({
            deviceId: child.deviceId,
            credentialRevision: 0,
            deviceToken: child.token
          })
        ).toBeNull()
      }
      expect(registry.getDevice(fork.deviceId)).not.toBeNull()
    }
  )
})
