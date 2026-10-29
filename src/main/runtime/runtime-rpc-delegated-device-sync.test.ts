// A phone's delegated child removed on disk must come back fresh in the same sync, not the next one.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { DeviceRegistry } from './device-registry'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

let server: OrcaRuntimeRpcServer
let registry: DeviceRegistry
let parentDeviceId: string

beforeEach(async () => {
  server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-delegated-sync-')),
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'desktop',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  parentDeviceId = offer.deviceId
  const current = server.getDeviceRegistry()
  if (!current) {
    throw new Error('expected a device registry')
  }
  registry = current
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server.stop()
})

function sync(name: string) {
  return server['syncDelegatedMobileDevices'](parentDeviceId, [{ phoneKey: 'phone-1', name }])
    .devices
}

function removeOnDisk(deviceId: string): void {
  const path = registry['registryPath']
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
}

describe('delegated mobile device sync', () => {
  it('hands the phone a fresh child when the save dropped the one removed on disk', () => {
    const [first] = sync('Pixel')
    if (!first) {
      throw new Error('expected a delegated child')
    }

    removeOnDisk(first.deviceId)
    // A rename makes the save rewrite the child row, which the merge drops.
    const devices = sync('Pixel 9')

    expect(devices).toHaveLength(1)
    const [fresh] = devices
    expect(fresh?.deviceId).not.toBe(first.deviceId)
    expect(registry.validateToken(fresh?.token ?? '')?.name).toBe('Pixel 9')
    expect(registry.validateToken(first.token)).toBeNull()
  })

  it('reruns at most once', () => {
    const upsert = vi.spyOn(registry, 'upsertDelegatedMobileDevices').mockReturnValue([])

    expect(sync('Pixel')).toEqual([])
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('does not rerun when every phone got its child', () => {
    const upsert = vi.spyOn(registry, 'upsertDelegatedMobileDevices')

    expect(sync('Pixel')).toHaveLength(1)
    expect(upsert).toHaveBeenCalledOnce()
  })
})
