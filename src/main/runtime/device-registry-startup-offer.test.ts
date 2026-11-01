import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'

let dir: string | null = null
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = null
})

// SSH/WSL re-pair from enrolled grants because startup offers rotate after use.
describe("orcad's startup pairing offer", () => {
  it('repeats while unused, and names a new device once a client has paired with it', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-startup-offer-'))
    const registry = new DeviceRegistry(dir)
    const first = registry.getOrCreatePendingDevice('CLI', 'runtime')
    expect(new DeviceRegistry(dir).getOrCreatePendingDevice('CLI', 'runtime').deviceId).toBe(
      first.deviceId
    )
    registry.updateLastSeen(first.deviceId)
    const next = new DeviceRegistry(dir).getOrCreatePendingDevice('CLI', 'runtime')
    expect(next.deviceId).not.toBe(first.deviceId)
    expect(next.token).not.toBe(first.token)
    expect(new DeviceRegistry(dir).getDevice(first.deviceId)).not.toBeNull()
  })
})
