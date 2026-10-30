import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEVICE_REGISTRY_FILENAME, E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

// Simulate app.setName changing userData; distinct directories work even on case-insensitive filesystems.
const appState = { userData: '' }

// getPath uses AppEnvironment; safeStorage still calls Electron directly.
installFakeAppEnvironment({ getPath: () => appState.userData })

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

describe('mobile pairing userData path stability', () => {
  let root: string
  let canonicalDir: string
  let lateDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-pairing-path-'))
    canonicalDir = join(root, 'userdata-early')
    lateDir = join(root, 'userdata-late')
    mkdirSync(canonicalDir, { recursive: true })
    mkdirSync(lateDir, { recursive: true })
    // Global beforeEach reinstalls its own environment.
    installFakeAppEnvironment({ getPath: () => appState.userData })
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.resetModules()
  })

  it('keeps returning the path captured before app.setName changes resolution', async () => {
    appState.userData = canonicalDir
    const { initDataPath, getCanonicalUserDataPath } = await import('../persistence')
    initDataPath()

    appState.userData = lateDir

    expect(getCanonicalUserDataPath()).toBe(canonicalDir)
    const { getAppEnvironment } = await import('../../shared/app-environment')
    expect(getCanonicalUserDataPath()).not.toBe(getAppEnvironment().getPath('userData'))
  })

  it('writes DeviceRegistry + E2EE keypair under the canonical path, not the late one', async () => {
    appState.userData = canonicalDir
    const { initDataPath, getCanonicalUserDataPath } = await import('../persistence')
    initDataPath()

    appState.userData = lateDir

    const { DeviceRegistry } = await import('./device-registry')
    const { loadOrCreateE2EEKeypair } = await import('./e2ee-keypair')

    // Mirror runtime startup: registry and E2EE keys share one canonical path.
    const registry = new DeviceRegistry(getCanonicalUserDataPath())
    registry.addDevice('iPhone')
    loadOrCreateE2EEKeypair(getCanonicalUserDataPath())

    expect(existsSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME))).toBe(true)
    expect(existsSync(join(canonicalDir, E2EE_KEYPAIR_FILENAME))).toBe(true)
    expect(existsSync(join(lateDir, DEVICE_REGISTRY_FILENAME))).toBe(false)
    expect(existsSync(join(lateDir, E2EE_KEYPAIR_FILENAME))).toBe(false)
  })

  it('migrates existing mobile pairing files from the late path as an all-or-nothing pair', async () => {
    appState.userData = canonicalDir
    const {
      initDataPath,
      getCanonicalUserDataPath,
      migrateMobilePairingDataToCanonicalUserDataPath
    } = await import('../persistence')
    initDataPath()

    appState.userData = lateDir
    const lateDevices = JSON.stringify([
      {
        deviceId: 'late-phone',
        name: 'iPhone',
        token: 'late-token',
        scope: 'mobile',
        pairedAt: 1,
        lastSeenAt: 2
      }
    ])
    const lateKeypair = JSON.stringify({
      v: 1,
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
      secretKeyB64: Buffer.from(new Uint8Array(32).fill(2)).toString('base64')
    })
    writeFileSync(join(lateDir, DEVICE_REGISTRY_FILENAME), lateDevices)
    writeFileSync(join(lateDir, E2EE_KEYPAIR_FILENAME), lateKeypair)

    migrateMobilePairingDataToCanonicalUserDataPath(appState.userData)

    expect(readFileSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME), 'utf-8')).toBe(lateDevices)
    expect(readFileSync(join(canonicalDir, E2EE_KEYPAIR_FILENAME), 'utf-8')).toBe(lateKeypair)

    const { DeviceRegistry } = await import('./device-registry')
    const registry = new DeviceRegistry(getCanonicalUserDataPath())
    expect(registry.getDevice('late-phone')?.token).toBe('late-token')

    writeFileSync(join(lateDir, DEVICE_REGISTRY_FILENAME), JSON.stringify([]))
    migrateMobilePairingDataToCanonicalUserDataPath(appState.userData)
    expect(readFileSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME), 'utf-8')).toBe(lateDevices)
  })

  it('skips legacy migration when only part of the canonical credential pair exists', async () => {
    appState.userData = canonicalDir
    const { initDataPath, migrateMobilePairingDataToCanonicalUserDataPath } =
      await import('../persistence')
    initDataPath()

    appState.userData = lateDir
    const lateDevices = JSON.stringify([
      {
        deviceId: 'late-phone',
        name: 'iPhone',
        token: 'late-token',
        scope: 'mobile',
        pairedAt: 1,
        lastSeenAt: 2
      }
    ])
    const lateKeypair = JSON.stringify({
      v: 1,
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
      secretKeyB64: Buffer.from(new Uint8Array(32).fill(2)).toString('base64')
    })
    const canonicalKeypair = JSON.stringify({
      v: 1,
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(3)).toString('base64'),
      secretKeyB64: Buffer.from(new Uint8Array(32).fill(4)).toString('base64')
    })
    writeFileSync(join(lateDir, DEVICE_REGISTRY_FILENAME), lateDevices)
    writeFileSync(join(lateDir, E2EE_KEYPAIR_FILENAME), lateKeypair)
    writeFileSync(join(canonicalDir, E2EE_KEYPAIR_FILENAME), canonicalKeypair)

    migrateMobilePairingDataToCanonicalUserDataPath(appState.userData)

    expect(existsSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME))).toBe(false)
    expect(readFileSync(join(canonicalDir, E2EE_KEYPAIR_FILENAME), 'utf-8')).toBe(canonicalKeypair)
  })

  it('rolls back the first copy when the second file fails to migrate', async () => {
    // Partial copy splits registry/key and blocks migration retries via the existing-target guard.
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs')
      let copies = 0
      return {
        ...actual,
        default: actual,
        copyFileSync: (source: string, target: string) => {
          copies += 1
          if (copies === 2) {
            throw new Error('simulated copy failure')
          }
          actual.copyFileSync(source, target)
        }
      }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      appState.userData = canonicalDir
      const { initDataPath, migrateMobilePairingDataToCanonicalUserDataPath } =
        await import('../persistence')
      initDataPath()

      appState.userData = lateDir
      writeFileSync(join(lateDir, DEVICE_REGISTRY_FILENAME), JSON.stringify([]))
      writeFileSync(join(lateDir, E2EE_KEYPAIR_FILENAME), JSON.stringify({ v: 1 }))

      expect(() => migrateMobilePairingDataToCanonicalUserDataPath(appState.userData)).not.toThrow()

      expect(errorSpy).toHaveBeenCalled()
      expect(existsSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME))).toBe(false)
      expect(existsSync(join(canonicalDir, E2EE_KEYPAIR_FILENAME))).toBe(false)
    } finally {
      errorSpy.mockRestore()
      vi.doUnmock('node:fs')
    }
  })

  it('no-ops when the source path equals the canonical path (no rename happened)', async () => {
    // Case-insensitive filesystems can resolve both paths identically; never copy a file onto itself.
    appState.userData = canonicalDir
    const { initDataPath, migrateMobilePairingDataToCanonicalUserDataPath } =
      await import('../persistence')
    initDataPath()

    const devices = JSON.stringify([
      { deviceId: 'phone', name: 'iPhone', token: 't', scope: 'mobile', pairedAt: 1, lastSeenAt: 2 }
    ])
    writeFileSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME), devices)

    expect(() => migrateMobilePairingDataToCanonicalUserDataPath(canonicalDir)).not.toThrow()
    expect(readFileSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME), 'utf-8')).toBe(devices)
  })

  it('no-ops on a fresh install with no legacy pairing files to migrate', async () => {
    appState.userData = canonicalDir
    const { initDataPath, migrateMobilePairingDataToCanonicalUserDataPath } =
      await import('../persistence')
    initDataPath()

    appState.userData = lateDir
    expect(() => migrateMobilePairingDataToCanonicalUserDataPath(appState.userData)).not.toThrow()
    expect(existsSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME))).toBe(false)
    expect(existsSync(join(canonicalDir, E2EE_KEYPAIR_FILENAME))).toBe(false)
  })

  it('a previously paired device is still found after a restart on the canonical path', async () => {
    appState.userData = canonicalDir
    {
      const { initDataPath, getCanonicalUserDataPath } = await import('../persistence')
      initDataPath()
      appState.userData = lateDir
      const { DeviceRegistry } = await import('./device-registry')
      new DeviceRegistry(getCanonicalUserDataPath()).addDevice('iPhone')
    }

    vi.resetModules()
    appState.userData = canonicalDir
    const { initDataPath, getCanonicalUserDataPath } = await import('../persistence')
    initDataPath()
    appState.userData = lateDir
    const { DeviceRegistry } = await import('./device-registry')
    const registry = new DeviceRegistry(getCanonicalUserDataPath())

    expect(registry.listDevices().map((d) => d.name)).toContain('iPhone')
  })
})
