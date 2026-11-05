// A load that drops an unreadable row (e.g. one a newer Orca wrote) quarantines the file at the
// first save; that missing file is this process's own doing and must not revoke the valid rows.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function quarantinedCopies(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(`${DEVICE_REGISTRY_FILENAME}.corrupt-`))
}

/** A paired, seen phone in a file that also holds a row this build can't read. */
function partiallyCorruptRegistry() {
  const first = new DeviceRegistry(dir)
  const phone = first.addDevice('phone', 'mobile')
  first.updateLastSeen(phone.deviceId)
  const rows: unknown[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
  writeFileSync(registryPath(), JSON.stringify([...rows, { deviceId: 'x', bogus: true }]))
  const registry = new DeviceRegistry(dir)
  expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  return { registry, phone }
}

describe('device registry after quarantining its own corrupt file', () => {
  it('keeps every valid device through the first save', () => {
    const { registry, phone } = partiallyCorruptRegistry()

    const added = registry.addDevice('new desktop', 'runtime')

    expect(quarantinedCopies()).toHaveLength(1)
    expect(fileIds()).toEqual([phone.deviceId, added.deviceId])
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
    expect(new DeviceRegistry(dir).validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })

  it('keeps them when the write after the quarantine failed, on the next save', () => {
    const { registry, phone } = partiallyCorruptRegistry()
    vi.spyOn(secureFile, 'writeSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => registry.addDevice('new desktop', 'runtime')).toThrow('disk full')
    expect(quarantinedCopies()).toHaveLength(1)
    expect(existsSync(registryPath())).toBe(false)
    const added = registry.addDevice('new desktop', 'runtime')

    expect(fileIds()).toEqual([phone.deviceId, added.deviceId])
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })

  it('keeps a device another writer added between its quarantine and its write', () => {
    const { registry, phone } = partiallyCorruptRegistry()
    vi.spyOn(secureFile, 'writeSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => registry.addDevice('new desktop', 'runtime')).toThrow('disk full')
    // E.g. the pairing CLI on the host, writing through its own registry instance.
    const cliPaired = new DeviceRegistry(dir).addDevice('cli pairing', 'runtime')

    const added = registry.addDevice('new desktop', 'runtime')

    expect(fileIds()).toEqual([phone.deviceId, added.deviceId, cliPaired.deviceId])
    expect(registry.validateToken(cliPaired.token)?.deviceId).toBe(cliPaired.deviceId)
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })

  it('still revokes everything when the file is deleted after its own write landed', () => {
    const { registry, phone } = partiallyCorruptRegistry()
    registry.addDevice('new desktop', 'runtime')

    rmSync(registryPath())
    const added = registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([added.deviceId])
    expect(registry.validateToken(phone.token)).toBeNull()
  })

  it('revokes everything when an intact file is deleted, as before', () => {
    const registry = new DeviceRegistry(dir)
    const phone = registry.addDevice('phone', 'mobile')

    rmSync(registryPath())
    const added = registry.addDevice('desktop', 'runtime')

    expect(fileIds()).toEqual([added.deviceId])
    expect(registry.getDevice(phone.deviceId)).toBeNull()
    expect(registry.validateToken(phone.token)).toBeNull()
  })

  it('treats a corrupt file deleted by someone else before the quarantine as a revoke', () => {
    const { registry, phone } = partiallyCorruptRegistry()

    rmSync(registryPath())
    const added = registry.addDevice('new desktop', 'runtime')

    expect(quarantinedCopies()).toEqual([])
    expect(fileIds()).toEqual([added.deviceId])
    expect(registry.validateToken(phone.token)).toBeNull()
  })
})
