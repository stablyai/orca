// A paired-device change listener reads the registry it was told about: the host's browser rows
// re-read which computers are the owner's from inside it, on add and on revoke.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { removeTreeSync } from '../../../../../shared/file-write/windows-transient-lock-removal'
import { DeviceRegistry } from './device-registry'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-listener-'))
})

afterEach(() => {
  removeTreeSync(dir)
})

it('lets a change listener see an added computer, and no longer see a revoked one', () => {
  const registry = new DeviceRegistry(dir)
  const seen: string[][] = []
  registry.setOnPairedDevicesChanged(() =>
    seen.push(registry.listDevices().map((device) => device.deviceId))
  )
  const desk = registry.addDevice('Desk', 'runtime').deviceId
  expect(seen.at(-1)).toContain(desk)
  expect(registry.removeDevice(desk)).toBe(true)
  expect(seen.at(-1)).not.toContain(desk)
})
