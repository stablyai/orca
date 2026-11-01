// An admin's removal on disk must stop authentication at the next check, not at orcad's next save.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file'
import { DeviceRegistry } from './device-registry'
import * as fileRead from './device-registry-file-read'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-auth-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function registryPath(): string {
  return join(dir, DEVICE_REGISTRY_FILENAME)
}

function removeOnDisk(deviceId: string): void {
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
  writeFileSync(registryPath(), JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
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

  it('refuses a keyed device removed on disk, and answers unknown for its key', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.addDevice('desktop', 'runtime')
    const keyed = registry.forkDeviceKey(
      desktop.deviceId,
      Buffer.alloc(32, 1).toString('base64'),
      'Tab'
    )
    const principal = {
      deviceId: keyed.deviceId,
      credentialRevision: keyed.credentialRevision ?? 0
    }
    expect(registry.resolveAuthenticatedPrincipal(principal)?.deviceId).toBe(keyed.deviceId)

    removeOnDisk(keyed.deviceId)

    expect(registry.resolveAuthenticatedPrincipal(principal)).toBeNull()
    expect(registry.lookupDeviceKey(keyed.deviceId)).toEqual({ kind: 'unknown' })
  })

  it('only stats the file while it is unchanged', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.addDevice('desktop', 'runtime')
    // The first check after this process's own save re-reads once.
    registry.validateToken(desktop.token)
    const reads = vi.spyOn(fileRead, 'readDeviceRegistryFile')

    for (let i = 0; i < 5; i++) {
      expect(registry.validateToken(desktop.token)?.deviceId).toBe(desktop.deviceId)
    }

    expect(reads).not.toHaveBeenCalled()
    writeFileSync(registryPath(), `${readFileSync(registryPath(), 'utf8')}\n`)
    registry.validateToken(desktop.token)
    expect(reads).toHaveBeenCalledOnce()
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

  it('never shows a pending offer that was removed on disk', () => {
    const registry = new DeviceRegistry(dir)
    const offer = registry.getOrCreatePendingDevice('phone', 'mobile')
    expect(registry.getOrCreatePendingDevice('phone', 'mobile').deviceId).toBe(offer.deviceId)

    removeOnDisk(offer.deviceId)
    const fresh = registry.getOrCreatePendingDevice('phone', 'mobile')

    expect(fresh.deviceId).not.toBe(offer.deviceId)
    expect(registry.validateToken(offer.token)).toBeNull()
    removeOnDisk(fresh.deviceId)
    expect(registry.getPendingDevice('mobile')).toBeNull()
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

  it('accepts a device another writer added, with no save in between', () => {
    const registry = new DeviceRegistry(dir)
    registry.addDevice('desktop', 'runtime')
    // E.g. the pairing CLI on the host, writing through its own registry instance.
    const added = new DeviceRegistry(dir).addDevice('cli pairing', 'runtime')

    expect(registry.validateToken(added.token)?.deviceId).toBe(added.deviceId)
  })
})
