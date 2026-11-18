// Paired-device tokens are stored as SHA-256 hashes: reading orca-devices.json yields nothing that signs in.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { devicePrincipalOf } from './device-principal'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-hash-'))
  vi.useFakeTimers({ toFake: ['performance'] })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const LEGACY_TOKEN = 'a1'.repeat(24)
const LEGACY_HASH = createHash('sha256').update(LEGACY_TOKEN).digest('hex')

function file(): string {
  return readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf8')
}

function writeRows(rows: unknown[]): void {
  writeFileSync(join(dir, DEVICE_REGISTRY_FILENAME), JSON.stringify(rows))
}

function phoneRow(deviceId: string, token: string) {
  return { deviceId, name: 'iPhone', token, scope: 'mobile', pairedAt: 1, lastSeenAt: 2 }
}

describe('device token storage', () => {
  it('hashes an older build’s plain-text tokens in place; the phone keeps signing in as itself', () => {
    writeRows([phoneRow('phone', LEGACY_TOKEN)])

    const registry = new DeviceRegistry(dir)

    expect(file()).not.toContain(LEGACY_TOKEN)
    expect(JSON.parse(file())).toEqual([expect.objectContaining({ tokenHash: LEGACY_HASH })])
    const signedIn = registry.validateToken(LEGACY_TOKEN)
    expect(signedIn?.deviceId).toBe('phone')
    // Same orchestration owner and terminal client id as before the migration.
    expect(devicePrincipalOf(signedIn!)).toMatchObject({
      callerFingerprint: LEGACY_HASH,
      clientId: LEGACY_TOKEN
    })
    expect(new DeviceRegistry(dir).validateToken(LEGACY_TOKEN)?.deviceId).toBe('phone')
  })

  it('never writes a new token to the file', () => {
    const registry = new DeviceRegistry(dir)
    const offer = registry.addDevice('desktop', 'runtime')

    expect(file()).not.toContain(offer.token)
    expect(new DeviceRegistry(dir).validateToken(offer.token)?.deviceId).toBe(offer.deviceId)
  })

  it('refuses a plain-text row written into the file later, now and after a restart', () => {
    const registry = new DeviceRegistry(dir)
    registry.addDevice('desktop', 'runtime')
    const rows: unknown[] = JSON.parse(file())
    writeRows([...rows, phoneRow('planted', LEGACY_TOKEN)])
    vi.advanceTimersByTime(1_001)

    expect(registry.validateToken(LEGACY_TOKEN)).toBeNull()
    expect(new DeviceRegistry(dir).validateToken(LEGACY_TOKEN)).toBeNull()
  })
})
