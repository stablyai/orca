import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

const DEVICE_REGISTRY_FILENAME = 'orca-devices.json'
const E2EE_KEYPAIR_FILENAME = 'orca-e2ee-keypair.json'

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
