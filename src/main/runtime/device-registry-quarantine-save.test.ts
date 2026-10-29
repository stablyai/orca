// A load that dropped an unparseable row sets the file aside before the first save. That missing
// file is this process's doing, so the save must keep every device it knows; only a delete by
// someone else revokes them.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-quarantine-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function registryPath(): string {
  return join(dir, DEVICE_REGISTRY_FILENAME)
}

function fileIds(): string[] {
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
  return rows.map((row) => row.deviceId)
}

/** Two paired devices, then a row no load can normalize appended to the file. */
function partiallyCorruptRegistry() {
  const writer = new DeviceRegistry(dir)
  const desktop = writer.addDevice('desktop', 'runtime')
  const phone = writer.addDevice('phone', 'mobile')
  const rows: unknown[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
  writeFileSync(registryPath(), JSON.stringify([...rows, { deviceId: 'broken' }]))
  return { desktop, phone }
}

describe('device registry first save after a partially corrupt load', () => {
  it('keeps every valid device and sets the corrupt file aside', () => {
    const { desktop, phone } = partiallyCorruptRegistry()
    const registry = new DeviceRegistry(dir)

    const added = registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([desktop.deviceId, phone.deviceId, added.deviceId])
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
    expect(new DeviceRegistry(dir).validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
    expect(readdirSync(dir).some((name) => name.includes('.corrupt-'))).toBe(true)
  })

  it('keeps them when the save after the quarantine failed and a later one lands', () => {
    const { desktop, phone } = partiallyCorruptRegistry()
    const registry = new DeviceRegistry(dir)
    vi.spyOn(secureFile, 'writeSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => registry.addDevice('lost', 'runtime')).toThrow('disk full')
    const added = registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([desktop.deviceId, phone.deviceId, added.deviceId])
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })

  it('still revokes every known device when someone else deletes a readable file', () => {
    const writer = new DeviceRegistry(dir)
    const phone = writer.addDevice('phone', 'mobile')
    const registry = new DeviceRegistry(dir)

    rmSync(registryPath())
    const added = registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([added.deviceId])
    expect(registry.validateToken(phone.token)).toBeNull()
  })
})
