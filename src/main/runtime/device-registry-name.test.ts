import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'

describe('DeviceRegistry.updateName', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function createRegistry(): DeviceRegistry {
    const dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-'))
    dirs.push(dir)
    return new DeviceRegistry(dir)
  }

  it('renames a device and persists across reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-'))
    dirs.push(dir)
    const registry = new DeviceRegistry(dir)
    const device = registry.addDevice('Mobile 7/3/2026', 'mobile')

    expect(registry.updateName(device.deviceId, 'iPhone 15 Pro Max')).toBe(true)
    expect(registry.getDevice(device.deviceId)?.name).toBe('iPhone 15 Pro Max')

    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.getDevice(device.deviceId)?.name).toBe('iPhone 15 Pro Max')
  })

  it('no-ops when the name is unchanged', () => {
    const registry = createRegistry()
    const device = registry.addDevice('iPhone 15 Pro Max', 'mobile')
    expect(registry.updateName(device.deviceId, 'iPhone 15 Pro Max')).toBe(false)
  })

  it('rejects empty names', () => {
    const registry = createRegistry()
    const device = registry.addDevice('Mobile 1/1/2026', 'mobile')
    expect(registry.updateName(device.deviceId, '   ')).toBe(false)
    expect(registry.getDevice(device.deviceId)?.name).toBe('Mobile 1/1/2026')
  })
})
