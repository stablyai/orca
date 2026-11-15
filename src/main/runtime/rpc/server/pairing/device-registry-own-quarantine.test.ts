// A load that drops an unreadable row (e.g. one a newer Orca wrote) quarantines the file at the
// first save; that missing file is this process's own doing and must not revoke the valid rows.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../../../../shared/secure-storage/secure-file'
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
  expect(() => registry.validateToken(phone.token)).toThrowError(
    expect.objectContaining({ code: 'registry_unavailable' })
  )
  return { registry, phone }
}

describe('device registry after quarantining its own corrupt file', () => {
  it('does not restore a repaired phone offer after an external revocation', () => {
    writeFileSync(registryPath(), '{ broken')
    const registry = new DeviceRegistry(dir)
    writeFileSync(registryPath(), '[]')
    const phone = new DeviceRegistry(dir).addDevice('phone', 'mobile')
    registry.refreshAuthority()

    writeFileSync(registryPath(), '[]')
    registry.addDevice('desktop', 'runtime')

    expect(registry.validateToken(phone.token)).toBeNull()
    expect(quarantinedCopies()).toEqual([])
  })

  it('does not quarantine a different corrupt snapshot or restore its stale rows', () => {
    const { registry } = partiallyCorruptRegistry()
    writeFileSync(registryPath(), '[')

    expect(() => registry.addDevice('desktop', 'runtime')).toThrowError(
      expect.objectContaining({ code: 'registry_unavailable' })
    )
    expect(readFileSync(registryPath(), 'utf8')).toBe('[')
    expect(quarantinedCopies()).toEqual([])
  })

  it('preserves the unchanged malformed snapshot when recovering the registry', () => {
    writeFileSync(registryPath(), '{ broken')
    const registry = new DeviceRegistry(dir)
    const added = registry.addDevice('desktop', 'runtime')

    expect(registry.validateToken(added.token)?.name).toBe('desktop')
    expect(quarantinedCopies().map((name) => readFileSync(join(dir, name), 'utf8'))).toContain(
      '{ broken'
    )
  })

  it('keeps them when the write after the quarantine failed, on the next save', () => {
    const { registry, phone } = partiallyCorruptRegistry()
    vi.spyOn(secureFile, 'writeSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => registry.addDevice('new desktop', 'runtime')).toThrowError(
      expect.objectContaining({ code: 'registry_unavailable', reason: 'io' })
    )
    expect(existsSync(registryPath())).toBe(false)
    const added = registry.addDevice('new desktop', 'runtime')

    expect(fileIds()).toEqual([phone.deviceId, added.deviceId])
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })

  it('honors a healthy external snapshot after its quarantine write failed', () => {
    const { registry, phone } = partiallyCorruptRegistry()
    vi.spyOn(secureFile, 'writeSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => registry.addDevice('new desktop', 'runtime')).toThrowError(
      expect.objectContaining({ code: 'registry_unavailable', reason: 'io' })
    )
    // E.g. the pairing CLI on the host, writing through its own registry instance.
    const cliPaired = new DeviceRegistry(dir).addDevice('cli pairing', 'runtime')

    const added = registry.addDevice('new desktop', 'runtime')

    expect(
      JSON.parse(readFileSync(registryPath(), 'utf8')).map((row: { name: string }) => row.name)
    ).toEqual(['new desktop', 'cli pairing'])
    expect(registry.validateToken(cliPaired.token)?.deviceId).toBe(cliPaired.deviceId)
    expect(registry.validateToken(added.token)?.name).toBe('new desktop')
    expect(registry.validateToken(phone.token)).toBeNull()
  })

  it('still revokes everything when the file is deleted after its own write landed', () => {
    const { registry, phone } = partiallyCorruptRegistry()
    registry.addDevice('new desktop', 'runtime')

    rmSync(registryPath())
    const added = registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([added.deviceId])
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
