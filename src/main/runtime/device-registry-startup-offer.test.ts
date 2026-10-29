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

  it('does not reuse, widen, or rotate a dedicated client root before its first connection', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-startup-offer-'))
    const registry = new DeviceRegistry(dir)
    const dedicated = registry.addDevice('Window', 'runtime', 'this-computer', [], {
      dedicated: true
    })
    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.getPendingDevice('runtime')).toBeNull()
    const pending = reloaded.getOrCreatePendingDevice('CLI', 'runtime')
    expect(pending.deviceId).not.toBe(dedicated.deviceId)
    expect(reloaded.getDevice(dedicated.deviceId)).toMatchObject({
      pairingReach: 'this-computer',
      lastSeenAt: 0
    })
    expect(reloaded.getOrCreatePendingDevice('Repeat', 'runtime').deviceId).toBe(pending.deviceId)
    const rotated = reloaded.rotatePendingDevice('New QR', 'runtime')
    expect(rotated.deviceId).not.toBe(pending.deviceId)
    expect(reloaded.validateToken(pending.token)).toBeNull()
    expect(reloaded.validateToken(dedicated.token)?.deviceId).toBe(dedicated.deviceId)
    expect(new DeviceRegistry(dir).validateToken(dedicated.token)?.pairingReach).toBe(
      'this-computer'
    )
  })
})
