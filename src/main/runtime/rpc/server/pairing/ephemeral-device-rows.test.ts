import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import './device-key-fork'
import { DeviceRegistry } from './device-registry'

import type { DeviceEntry } from './device-entry'
import { EPHEMERAL_DEVICE_IDLE_MS } from './ephemeral-device-rows'
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

function registryWith(rows: DeviceEntry[]): { dir: string; registry: DeviceRegistry } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ephemeral-rows-'))
  dirs.push(dir)
  writeFileSync(join(dir, DEVICE_REGISTRY_FILENAME), JSON.stringify(rows))
  return { dir, registry: new DeviceRegistry(dir) }
}

describe('ephemeral device rows', () => {
  it('removes idle rows from the registry durably', () => {
    const { dir, registry } = registryWith([tokenRow()])
    const fork = registry.forkDeviceKey('legacy', KEY_A, 'Tab', { ephemeral: true })
    const removed = registry.pruneIdleEphemeralDevices(
      fork.lastSeenAt + EPHEMERAL_DEVICE_IDLE_MS + 1,
      () => false
    )
    expect(removed).toEqual([fork.deviceId])
    expect(registry.lookupDeviceKey(fork.deviceId)).toEqual({ kind: 'unknown' })
    const onDisk = JSON.parse(readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf8'))
    expect(onDisk.map((row: DeviceEntry) => row.deviceId)).toEqual(['legacy'])
  })
})
