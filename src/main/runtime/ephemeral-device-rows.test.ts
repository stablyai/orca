import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planDeviceKeyFork } from './device-key-fork'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { EPHEMERAL_DEVICE_IDLE_MS, planIdleEphemeralPrune } from './ephemeral-device-rows'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

const KEY_A = Buffer.alloc(32, 1).toString('base64')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tokenRow(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  return {
    deviceId: 'legacy',
    name: 'Browser',
    token: 'token',
    scope: 'runtime',
    pairedAt: 1,
    lastSeenAt: 2,
    ...overrides
  }
}

function keyedRow(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  return {
    deviceId: 'keyed',
    name: 'Browser',
    scope: 'runtime',
    pairedAt: 1,
    lastSeenAt: 1_000,
    credentialKind: 'device-key',
    devicePublicKeyB64: KEY_A,
    forkedFrom: 'legacy',
    ephemeral: true,
    ...overrides
  }
}

function registryWith(rows: DeviceEntry[]): { dir: string; registry: DeviceRegistry } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ephemeral-rows-'))
  dirs.push(dir)
  writeFileSync(join(dir, DEVICE_REGISTRY_FILENAME), JSON.stringify(rows))
  return { dir, registry: new DeviceRegistry(dir) }
}

describe('ephemeral device rows', () => {
  it('marks a session-only fork ephemeral and keeps persistent forks unmarked', () => {
    const session = planDeviceKeyFork([tokenRow()], 'legacy', KEY_A, 'Tab', 9, {
      ephemeral: true
    })
    expect(session.entry.ephemeral).toBe(true)
    expect(planDeviceKeyFork([tokenRow()], 'legacy', KEY_A, 'Tab', 9).entry.ephemeral).toBe(
      undefined
    )
  })

  it('drops ephemeral rows when the host restarts and persists that', () => {
    const { dir, registry } = registryWith([tokenRow(), keyedRow()])
    expect(registry.getDevice('keyed')).toBeNull()
    expect(registry.lookupDeviceKey('keyed')).toEqual({ kind: 'unknown' })
    expect(registry.getDevice('legacy')).not.toBeNull()
    const onDisk = JSON.parse(readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf8'))
    expect(onDisk.map((row: DeviceEntry) => row.deviceId)).toEqual(['legacy'])
  })

  it('ignores an ephemeral flag on a token row', () => {
    const { registry } = registryWith([tokenRow({ ephemeral: true })])
    expect(registry.getDevice('legacy')?.ephemeral).toBeUndefined()
  })

  it('prunes only idle, disconnected ephemeral rows', () => {
    const rows = [
      tokenRow(),
      keyedRow(),
      keyedRow({ deviceId: 'live', lastSeenAt: 1_000 }),
      keyedRow({ deviceId: 'recent', lastSeenAt: 1_000 + EPHEMERAL_DEVICE_IDLE_MS }),
      keyedRow({ deviceId: 'persistent', ephemeral: undefined })
    ]
    const now = 2_000 + EPHEMERAL_DEVICE_IDLE_MS
    const plan = planIdleEphemeralPrune(rows, now, (deviceId) => deviceId === 'live')
    expect(plan.removed).toEqual(['keyed'])
    expect(plan.nextDevices.map((row) => row.deviceId)).toEqual([
      'legacy',
      'live',
      'recent',
      'persistent'
    ])
  })

  it('removes idle rows from the registry durably', () => {
    const { registry } = registryWith([tokenRow()])
    const fork = registry.forkDeviceKey('legacy', KEY_A, 'Tab', { ephemeral: true })
    const removed = registry.pruneIdleEphemeralDevices(
      fork.lastSeenAt + EPHEMERAL_DEVICE_IDLE_MS + 1,
      () => false
    )
    expect(removed).toEqual([fork.deviceId])
    expect(registry.lookupDeviceKey(fork.deviceId)).toEqual({ kind: 'unknown' })
  })
})
