import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'
import '../../../orca-runtime'
import '../runtime-rpc'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-desktop-control-grant-'))
}

describe('pairing-time grants on the device registry', () => {
  it('persist across a reload and are dropped for mobile devices', () => {
    const userDataPath = tempDir()
    const registry = new DeviceRegistry(userDataPath)
    const runtime = registry.addDevice('laptop', 'runtime', 'network', ['desktop-control'])
    const phone = registry.addDevice('phone', 'mobile', 'network', ['desktop-control'])

    const reloaded = new DeviceRegistry(userDataPath)
    expect(reloaded.getDevice(runtime.deviceId)?.grants).toEqual(['desktop-control'])
    expect(reloaded.getDevice(phone.deviceId)?.grants).toBeUndefined()
  })

  it('never widen a pending offer that was advertised without them', () => {
    const registry = new DeviceRegistry(tempDir())
    const plain = registry.getOrCreatePendingDevice('cli', 'runtime')
    const granted = registry.getOrCreatePendingDevice('cli', 'runtime', 'network', [
      'desktop-control'
    ])
    expect(granted.token).not.toBe(plain.token)
    expect(registry.getDevice(plain.deviceId)?.grants).toBeUndefined()
    expect(registry.getOrCreatePendingDevice('cli', 'runtime').token).toBe(plain.token)
  })
})
