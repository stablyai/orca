// Removing a desktop on disk (or by any path short of revokeRuntimeAccess) must also stop the
// phones it delegated: their rows can outlive it, so auth checks the parent.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-parent-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function removeOnDisk(deviceId: string): void {
  const path = join(dir, DEVICE_REGISTRY_FILENAME)
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
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
  it('accepts a delegated phone while its desktop is paired', () => {
    const { registry, child, principal } = delegatedRegistry()

    expect(registry.validateToken(child.token)?.deviceId).toBe(child.deviceId)
    expect(registry.resolveAuthenticatedPrincipal(principal)?.deviceId).toBe(child.deviceId)
  })

  it('refuses it once an admin removes the desktop on disk', () => {
    const { registry, desktop, child, principal } = delegatedRegistry()

    removeOnDisk(desktop.deviceId)

    expect(registry.validateToken(child.token)).toBeNull()
    expect(registry.resolveAuthenticatedPrincipal(principal)).toBeNull()
  })

  it('refuses it when the desktop row is removed without the cascade', () => {
    const { registry, desktop, child, principal } = delegatedRegistry()

    expect(registry.removeDevice(desktop.deviceId)).toBe(true)

    expect(registry.validateToken(child.token)).toBeNull()
    expect(registry.resolveAuthenticatedPrincipal(principal)).toBeNull()
  })

  it('leaves phones paired directly to this host alone', () => {
    const { registry, desktop } = delegatedRegistry()
    const phone = registry.addDevice('phone', 'mobile')

    removeOnDisk(desktop.deviceId)

    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })
})
