// An admin's device removal on the host (or the pairing CLI's add) lands in the file while orcad
// runs; a later save from orcad's memory must never resurrect a removed device.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-edit-'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function fileIds(): string[] {
  const rows: { deviceId: string }[] = JSON.parse(
    readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf8')
  )
  return rows.map((row) => row.deviceId)
}

/** What an admin does on the host: drop one row from the file, outside orcad. */
function removeOnDisk(deviceId: string): void {
  const path = join(dir, DEVICE_REGISTRY_FILENAME)
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
}

/** A registry with two devices that have both connected once, so later sightings are deferred. */
function pairedRegistry() {
  const registry = new DeviceRegistry(dir)
  const desktop = registry.addDevice('desktop', 'runtime')
  const phone = registry.addDevice('phone', 'mobile')
  registry.updateLastSeen(desktop.deviceId)
  registry.updateLastSeen(phone.deviceId)
  return { registry, desktop, phone }
}

describe('device registry saves over an externally edited file', () => {
  it('keeps a device removed on disk removed through a pending lastSeen flush', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { registry, desktop, phone } = pairedRegistry()
    registry.updateLastSeenDeferred(desktop.deviceId)

    removeOnDisk(desktop.deviceId)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(fileIds()).toEqual([phone.deviceId])
    expect(registry.getDevice(desktop.deviceId)).toBeNull()
    expect(registry.validateToken(desktop.token)).toBeNull()
  })

  it('keeps it removed through the shutdown flush', () => {
    const { registry, desktop, phone } = pairedRegistry()
    registry.updateLastSeenDeferred(desktop.deviceId)

    removeOnDisk(desktop.deviceId)
    // What RPC shutdown calls after closing transports.
    registry.flushPendingLastSeen()

    expect(fileIds()).toEqual([phone.deviceId])
    expect(new DeviceRegistry(dir).getDevice(desktop.deviceId)).toBeNull()
  })

  it('keeps it removed when this process adds a device meanwhile', () => {
    const { registry, desktop, phone } = pairedRegistry()

    removeOnDisk(desktop.deviceId)
    const added = registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([phone.deviceId, added.deviceId])
    expect(registry.getDevice(desktop.deviceId)).toBeNull()
  })

  it('keeps a device another writer added, and removes what this process removes', () => {
    const { registry, desktop, phone } = pairedRegistry()
    // E.g. the pairing CLI on the host, writing through its own registry instance.
    const added = new DeviceRegistry(dir).addDevice('cli pairing', 'runtime')

    registry.removeDevice(phone.deviceId)

    expect(fileIds()).toEqual([desktop.deviceId, added.deviceId])
    expect(registry.getDevice(added.deviceId)).not.toBeNull()
  })

  it('still drops the previous run’s session-only rows at load, not re-adding them from disk', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.addDevice('desktop', 'runtime')
    const fork = registry.forkDeviceKey(
      desktop.deviceId,
      Buffer.alloc(32, 1).toString('base64'),
      'Tab',
      {
        ephemeral: true
      }
    )
    expect(fileIds()).toContain(fork.deviceId)

    const reloaded = new DeviceRegistry(dir)

    expect(reloaded.getDevice(fork.deviceId)).toBeNull()
    expect(fileIds()).not.toContain(fork.deviceId)
  })

  // Review of #35483: a stale writer (an old orcad's flush during an upgrade overlap) puts back a
  // device this process revoked; the next save must not adopt it.
  it('never re-adopts a device this process removed when a stale writer puts it back', () => {
    const { registry, desktop, phone } = pairedRegistry()
    const path = join(dir, DEVICE_REGISTRY_FILENAME)
    const snapshot = readFileSync(path, 'utf8')

    expect(registry.removeDevice(desktop.deviceId)).toBe(true)
    writeFileSync(path, snapshot)
    registry.updateLastSeen(phone.deviceId)

    expect(fileIds()).toEqual([phone.deviceId])
    expect(registry.getDevice(desktop.deviceId)).toBeNull()
    expect(registry.validateToken(desktop.token)).toBeNull()
  })

  it('never re-adopts a session-only row whose load-time cleanup save failed', () => {
    const registry = new DeviceRegistry(dir)
    const desktop = registry.addDevice('desktop', 'runtime')
    const fork = registry.forkDeviceKey(
      desktop.deviceId,
      Buffer.alloc(32, 1).toString('base64'),
      'Tab',
      { ephemeral: true }
    )
    const writes = vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const reloaded = new DeviceRegistry(dir)
    expect(writes).toHaveBeenCalledOnce()
    expect(fileIds()).toContain(fork.deviceId)
    reloaded.addDevice('second desktop', 'runtime')

    expect(fileIds()).not.toContain(fork.deviceId)
    expect(reloaded.getDevice(fork.deviceId)).toBeNull()
  })

  it('reports a row update as not applied when the row was removed on disk, and keeps it removed', () => {
    const { registry, phone } = pairedRegistry()

    removeOnDisk(phone.deviceId)
    const applied = registry.setMobilePairingConnectionMode(phone.deviceId, 'local-only')

    expect(applied).toBe(false)
    expect(fileIds()).not.toContain(phone.deviceId)
    expect(registry.getDevice(phone.deviceId)).toBeNull()
  })

  // Review of #35483: a parent must never be handed the token of a child the file had dropped.
  it('returns no delegated child the save dropped because it was removed on disk', () => {
    const { registry, desktop } = pairedRegistry()
    const [child] = registry.upsertDelegatedMobileDevices(desktop, [
      { phoneKey: 'phone-1', name: 'Pixel' }
    ])
    if (!child) {
      throw new Error('expected a delegated child')
    }

    removeOnDisk(child.deviceId)
    // A rename makes the plan rewrite the child row, which the merge then drops.
    const returned = registry.upsertDelegatedMobileDevices(desktop, [
      { phoneKey: 'phone-1', name: 'Pixel 9' }
    ])

    expect(returned).toEqual([])
    expect(fileIds()).not.toContain(child.deviceId)
    expect(registry.validateToken(child.token)).toBeNull()
  })
})
