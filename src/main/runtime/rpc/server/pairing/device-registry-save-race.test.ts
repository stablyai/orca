import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FileReadModule from './device-registry-file-read'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

// Runs once right after the saving process has read the file: another process's write lands then.
const afterRead = vi.hoisted(() => {
  const state: { hook: (() => void) | null } = { hook: null }
  return state
})
vi.mock('./device-registry-file-read', async (importOriginal) => {
  const actual = await importOriginal<typeof FileReadModule>()
  return {
    ...actual,
    readDeviceRegistryFile: (path: string) => {
      const read = actual.readDeviceRegistryFile(path)
      const hook = afterRead.hook
      afterRead.hook = null
      hook?.()
      return read
    }
  }
})

let dir: string
let registryPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-registry-race-'))
  registryPath = join(dir, DEVICE_REGISTRY_FILENAME)
})

afterEach(() => {
  afterRead.hook = null
  rmSync(dir, { recursive: true, force: true })
})

function diskIds(): string[] {
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath, 'utf8'))
  return rows.map((row) => row.deviceId)
}

/** An admin's script, as in the docs: rewrite the file without the row (not atomic, no lock). */
function adminRemoves(deviceId: string): void {
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath, 'utf8'))
  writeFileSync(registryPath, JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
}

function pairedDevices(registry: DeviceRegistry) {
  const kept = registry.addDevice('Kept', 'runtime')
  const revoked = registry.addDevice('Revoked', 'runtime')
  registry.updateLastSeen(kept.deviceId)
  registry.updateLastSeen(revoked.deviceId)
  return { kept, revoked }
}

describe('device registry save racing another writer', () => {
  it('a lastSeen flush that read before an admin revoke does not write the row back', () => {
    const registry = new DeviceRegistry(dir)
    const { kept, revoked } = pairedDevices(registry)
    registry.updateLastSeenDeferred(revoked.deviceId)

    afterRead.hook = () => adminRemoves(revoked.deviceId)
    registry.flushPendingLastSeen()

    expect(diskIds()).toEqual([kept.deviceId])
    expect(registry.validateToken(revoked.token)).toBeNull()
    expect(new DeviceRegistry(dir).validateToken(revoked.token)).toBeNull()
    expect(registry.validateToken(kept.token)?.deviceId).toBe(kept.deviceId)
  })

  it('waits out an admin write caught half-way instead of treating it as a corrupt file', () => {
    const registry = new DeviceRegistry(dir)
    const { kept, revoked } = pairedDevices(registry)
    registry.updateLastSeenDeferred(revoked.deviceId)
    const full: { deviceId: string }[] = JSON.parse(readFileSync(registryPath, 'utf8'))
    const finished = JSON.stringify(full.filter((row) => row.deviceId !== revoked.deviceId))

    // The save reads a truncated file; the admin's write finishes right after.
    writeFileSync(registryPath, finished.slice(0, 10))
    afterRead.hook = () => writeFileSync(registryPath, finished)
    registry.flushPendingLastSeen()

    expect(diskIds()).toEqual([kept.deviceId])
  })
})
