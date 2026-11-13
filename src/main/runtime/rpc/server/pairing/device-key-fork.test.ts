import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import './device-key-fork'
import './device-principal'
import { DeviceRegistry } from './device-registry'

import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

describe('planDeviceKeyFork', () => {
  it('keeps a corrupt registry aside and never calls an unlisted key revoked while it exists', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-fork-'))
    writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), '[{"deviceId":"keyed",')
    const afterCrash = new DeviceRegistry(userDataPath)
    expect(afterCrash.lookupDeviceKey('keyed')).toEqual({ kind: 'unavailable' })
    afterCrash.getOrCreatePendingDevice('Re-pair', 'mobile')
    expect(readdirSync(userDataPath).some((name) => name.includes('.corrupt-'))).toBe(true)

    const nextLaunch = new DeviceRegistry(userDataPath)
    expect(nextLaunch.listDevices()).toHaveLength(1)
    expect(nextLaunch.lookupDeviceKey('keyed')).toEqual({ kind: 'unavailable' })
  })

  it('stays doubtful when the rewrite after quarantine never landed', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-key-fork-'))
    writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), '{')
    writeFileSync(join(userDataPath, `${DEVICE_REGISTRY_FILENAME}.corrupt-1`), '{')
    rmSync(join(userDataPath, DEVICE_REGISTRY_FILENAME))
    expect(new DeviceRegistry(userDataPath).lookupDeviceKey('keyed')).toEqual({
      kind: 'unavailable'
    })
  })
})
