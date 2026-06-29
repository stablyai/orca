import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// Import from the production source of truth so a filename rename can't silently
// pass these tests against stale names.
import { DEVICE_REGISTRY_FILENAME, E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

// Mutable userData the electron mock resolves. We flip it mid-test to simulate
// app.setName('Orca') changing how app.getPath('userData') resolves (e.g. from
// lowercase 'orca' to uppercase 'Orca' on a case-sensitive filesystem) — the
// divergence that drops paired devices. We use two genuinely distinct directory
// names rather than case variants so the assertion is deterministic regardless
// of whether the test host's filesystem is case-sensitive.
const appState = { userData: '' }

vi.mock('electron', () => ({
  app: { getPath: () => appState.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

describe('mobile pairing userData path stability', () => {
  let root: string
  // The path persistence captures early, before app.setName().
  let canonicalDir: string
  // The path app.getPath('userData') resolves to after app.setName() — a
  // distinct directory standing in for the post-rename resolution.
  let lateDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-pairing-path-'))
    canonicalDir = join(root, 'userdata-early')
    lateDir = join(root, 'userdata-late')
    mkdirSync(canonicalDir, { recursive: true })
    mkdirSync(lateDir, { recursive: true })
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

    // app.setName('Orca') happens later in startup, changing late resolution.
    appState.userData = lateDir

    expect(getCanonicalUserDataPath()).toBe(canonicalDir)
    const { app } = await import('electron')
    expect(getCanonicalUserDataPath()).not.toBe(app.getPath('userData'))
  })

  it('writes DeviceRegistry + E2EE keypair under the canonical path, not the late one', async () => {
    appState.userData = canonicalDir
    const { initDataPath, getCanonicalUserDataPath } = await import('../persistence')
    initDataPath()

    appState.userData = lateDir // app.setName('Orca') has run by the time the runtime starts

    const { DeviceRegistry } = await import('./device-registry')
    const { loadOrCreateE2EEKeypair } = await import('./e2ee-keypair')

    // Mirrors OrcaRuntimeRpcServer.start(): both read from the same userDataPath.
    const registry = new DeviceRegistry(getCanonicalUserDataPath())
    registry.addDevice('iPhone')
    loadOrCreateE2EEKeypair(getCanonicalUserDataPath())

    // Pairing credentials land beside orca-data.json so they survive restarts/updates.
    expect(existsSync(join(canonicalDir, DEVICE_REGISTRY_FILENAME))).toBe(true)
    expect(existsSync(join(canonicalDir, E2EE_KEYPAIR_FILENAME))).toBe(true)
    // The bug being guarded: the late path would have captured these instead.
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

  it('no-ops when the source path equals the canonical path (no rename happened)', async () => {
    // Case-insensitive filesystems (macOS/Windows) resolve both paths to the same
    // dir, so migration must be a clean no-op rather than copy a file onto itself.
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
    // First launch: pair a device while userData resolves to the canonical path.
    appState.userData = canonicalDir
    {
      const { initDataPath, getCanonicalUserDataPath } = await import('../persistence')
      initDataPath()
      appState.userData = lateDir
      const { DeviceRegistry } = await import('./device-registry')
      new DeviceRegistry(getCanonicalUserDataPath()).addDevice('iPhone')
    }

    // Second launch (e.g. after an update): fresh module state, path captured again.
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
