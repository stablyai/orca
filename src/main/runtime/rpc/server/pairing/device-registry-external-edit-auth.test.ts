// An admin's removal on disk must stop authentication within a second, not at orcad's next save.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../../../../shared/secure-file'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-auth-'))
  vi.useFakeTimers({ toFake: ['performance'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function registryPath(): string {
  return join(dir, DEVICE_REGISTRY_FILENAME)
}

// Auth checks see another process's edit once the registry's one-second stat window has passed.
function removeOnDisk(deviceId: string, advanceMs = 1000): void {
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
  writeFileSync(registryPath(), JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
  vi.advanceTimersByTime(advanceMs)
}

function spyOnSaves() {
  return [
    vi.spyOn(secureFile, 'writeSecureJsonFile'),
    vi.spyOn(secureFile, 'writeDurableSecureJsonFile')
  ]
}

describe('device registry auth checks see edits made on disk', () => {
  it('refuses a token removed on disk at the next validate, with no save in between', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.addDevice('desktop', 'runtime')
    const phone = registry.addDevice('phone', 'mobile')
    expect(registry.validateToken(desktop.token)?.deviceId).toBe(desktop.deviceId)
    const saves = spyOnSaves()

    removeOnDisk(desktop.deviceId)

    expect(registry.validateToken(desktop.token)).toBeNull()
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
    for (const save of saves) {
      expect(save).not.toHaveBeenCalled()
    }
  })

  it('refuses every device once the file is deleted, and keeps working', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.addDevice('desktop', 'runtime')

    rmSync(registryPath())

    expect(registry.validateToken(desktop.token)).toBeNull()
    expect(registry.listDevices()).toEqual([])
    const added = registry.addDevice('second desktop', 'runtime')
    expect(registry.validateToken(added.token)?.deviceId).toBe(added.deviceId)
  })

  it('keeps what it has when the file turns corrupt, since that proves no removal', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.addDevice('desktop', 'runtime')

    writeFileSync(registryPath(), '{ not json')

    expect(registry.validateToken(desktop.token)?.deviceId).toBe(desktop.deviceId)
    expect(readFileSync(registryPath(), 'utf8')).toBe('{ not json')
  })

  it('does not read its own quarantine as a delete when the write after it failed', () => {
    const first = new DeviceRegistry(dir)
    const phone = first.addDevice('phone', 'mobile')
    first.updateLastSeen(phone.deviceId)
    const rows: unknown[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
    writeFileSync(registryPath(), JSON.stringify([...rows, { deviceId: 'x', bogus: true }]))
    const registry = new DeviceRegistry(dir)
    vi.spyOn(secureFile, 'writeSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => registry.addDevice('desktop', 'runtime')).toThrow('disk full')

    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })
})
