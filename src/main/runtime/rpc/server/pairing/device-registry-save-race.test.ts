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
  it('keeps an operation failed after contention until the next independent operation', () => {
    const registry = new DeviceRegistry(dir)
    const device = registry.addDevice('Desktop', 'runtime')
    registry.updateLastSeen(device.deviceId)
    let sighting = 1_900_000_000_000
    const edit = () => {
      const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath, 'utf8'))
      writeFileSync(
        registryPath,
        JSON.stringify(
          rows.map((row) =>
            row.deviceId === device.deviceId ? { ...row, lastSeenAt: ++sighting } : row
          )
        )
      )
      afterRead.hook = edit
    }
    registry.runAuthorityOperation(() => {
      registry.addDevice('Committed', 'runtime')
      afterRead.hook = edit
      expect(() => registry.addDevice('Uncommitted', 'runtime')).toThrowError(
        expect.objectContaining({ code: 'registry_unavailable', reason: 'contended' })
      )
      afterRead.hook = null
      expect(() => registry.addDevice('No extra write', 'runtime')).toThrowError(
        expect.objectContaining({ code: 'registry_unavailable' })
      )
    })
    registry.addDevice('Recovered', 'runtime')
    expect(new DeviceRegistry(dir).listDevices().map((row) => row.name)).toEqual([
      'Desktop',
      'Committed',
      'Recovered'
    ])
  })
  it.each(['fork', 'delegation', 'offer'] as const)(
    'never reports an unapplied %s after a competing authority change',
    (operation) => {
      const registry = new DeviceRegistry(dir)
      const parent = registry.addDevice('Parent', 'runtime')
      if (operation !== 'offer') {
        registry.updateLastSeen(parent.deviceId)
      }
      afterRead.hook = () => {
        if (operation === 'offer') {
          const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath, 'utf8'))
          writeFileSync(
            registryPath,
            JSON.stringify(
              rows.map((row) => ({
                ...row,
                token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                credentialRevision: 1
              }))
            )
          )
        } else {
          adminRemoves(parent.deviceId)
        }
      }
      const mutate = () =>
        operation === 'fork'
          ? registry.forkDeviceKey(
              parent.deviceId,
              Buffer.alloc(32, 9).toString('base64'),
              'Browser'
            )
          : operation === 'delegation'
            ? registry.upsertDelegatedMobileDevices(parent, [{ phoneKey: 'phone', name: 'Phone' }])
            : registry.rotatePendingDevice('Fresh offer', 'runtime')
      expect(mutate).toThrowError(expect.objectContaining({ code: 'registry_unavailable' }))
      const reloaded = new DeviceRegistry(dir)
      expect(
        reloaded.listDevices().some((row) => ['Browser', 'Phone', 'Fresh offer'].includes(row.name))
      ).toBe(false)
      expect(reloaded.validateToken(parent.token)).toBeNull()
    }
  )
  it.each(['replacement', 'removal', 'same promotion'] as const)(
    'publishes a competing %s before accepting or refusing the actual presented token',
    (change) => {
      const registry = new DeviceRegistry(dir)
      const device = registry.addDevice('Desktop', 'runtime')
      registry.updateLastSeen(device.deviceId)
      const child = registry.forkDeviceKey(
        device.deviceId,
        Buffer.alloc(32, 4).toString('base64'),
        'Browser'
      )
      const childAuthority = registry.captureAuthority({
        deviceId: child.deviceId,
        credentialRevision: 0
      })!
      const presented = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const winning = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      registry.exchangePairingTicket(device.deviceId, device.token, presented)
      afterRead.hook = () => {
        if (change === 'same promotion') {
          expect(new DeviceRegistry(dir).validateToken(presented)?.token).toBe(presented)
        } else if (change === 'removal') {
          adminRemoves(device.deviceId)
        } else {
          const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath, 'utf8'))
          writeFileSync(
            registryPath,
            JSON.stringify(
              rows.map((row) =>
                row.deviceId === device.deviceId
                  ? {
                      ...row,
                      token: winning,
                      credentialRevision: 1,
                      ticket: undefined,
                      exchangeToken: undefined
                    }
                  : row
              )
            )
          )
        }
      }
      const accepted = registry.validateToken(presented)
      if (change === 'same promotion') {
        expect(accepted).toMatchObject({ token: presented, credentialRevision: 1 })
      } else {
        expect(accepted).toBeNull()
      }
      expect(registry.validateToken(device.token)).toBeNull()
      expect(childAuthority.signal.aborted).toBe(true)
      if (change === 'replacement') {
        expect(registry.validateToken(winning)?.token).toBe(winning)
      }
      if (change === 'removal') {
        expect(registry.lookupDeviceKey(child.deviceId)).toEqual({ kind: 'refused' })
      }
    }
  )

  it('refuses persistent contention without publishing its planned credential and a later request recovers', () => {
    const registry = new DeviceRegistry(dir)
    const device = registry.addDevice('Desktop', 'runtime')
    registry.updateLastSeen(device.deviceId)
    let sighting = 1000
    const edit = () => {
      const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath, 'utf8'))
      writeFileSync(
        registryPath,
        JSON.stringify(rows.map((row) => ({ ...row, lastSeenAt: ++sighting })))
      )
      afterRead.hook = edit
    }
    afterRead.hook = edit
    expect(() => registry.addDevice('Uncommitted', 'runtime')).toThrowError(
      expect.objectContaining({ code: 'registry_unavailable' })
    )
    afterRead.hook = null
    expect(new DeviceRegistry(dir).listDevices().map((row) => row.name)).toEqual(['Desktop'])
    expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)
    const later = registry.addDevice('Recovered', 'runtime')
    expect(new DeviceRegistry(dir).validateToken(later.token)?.deviceId).toBe(later.deviceId)
  })
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
