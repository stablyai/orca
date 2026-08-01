import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from './device-registry'

describe('DeviceRegistry token validation', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('matches each device token and rejects same-length mismatches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-device-registry-'))
    directories.push(directory)
    const registry = new DeviceRegistry(directory)
    const first = registry.addDevice('first')
    const second = registry.addDevice('second', 'runtime')
    const wrong = `${second.token.slice(0, -1)}${second.token.at(-1) === '0' ? '1' : '0'}`

    expect(registry.validateToken(first.token)?.deviceId).toBe(first.deviceId)
    expect(registry.validateToken(second.token)?.deviceId).toBe(second.deviceId)
    expect(registry.validateToken(wrong)).toBeNull()
  })
})
