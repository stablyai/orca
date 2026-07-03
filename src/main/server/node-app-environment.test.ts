import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NodeAppEnvironment } from './node-app-environment'
import { NodeSecretStore } from './node-secret-store'

describe('NodeAppEnvironment', () => {
  const prevEnv = { ...process.env }
  afterEach(() => {
    process.env = { ...prevEnv }
  })

  it('uses ORCA_USER_DATA_PATH for userData when no explicit override is given', () => {
    process.env.ORCA_USER_DATA_PATH = '/custom/data/dir'
    const env = new NodeAppEnvironment()
    expect(env.getPath('userData')).toBe('/custom/data/dir')
  })

  it('prefers an explicit option over the env var', () => {
    process.env.ORCA_USER_DATA_PATH = '/from/env'
    const env = new NodeAppEnvironment({ userDataPath: '/from/option' })
    expect(env.getPath('userData')).toBe('/from/option')
  })

  it('reports version from ORCA_APP_VERSION when set', () => {
    process.env.ORCA_APP_VERSION = '9.9.9'
    const env = new NodeAppEnvironment({ userDataPath: '/x' })
    expect(env.getVersion()).toBe('9.9.9')
  })

  it('defaults appPath to the launched entrypoint directory', () => {
    const env = new NodeAppEnvironment({ userDataPath: '/x' })
    const entry = process.argv[1] ?? process.execPath

    expect(env.getAppPath()).toBe(dirname(realpathSync(entry)))
  })

  it('treats deployment as packaged unless ORCA_IS_PACKAGED=0', () => {
    delete process.env.ORCA_IS_PACKAGED
    expect(new NodeAppEnvironment({ userDataPath: '/x' }).isPackaged()).toBe(true)
    process.env.ORCA_IS_PACKAGED = '0'
    expect(new NodeAppEnvironment({ userDataPath: '/x' }).isPackaged()).toBe(false)
  })

  it('falls back to a per-platform Orca data dir when nothing is configured', () => {
    delete process.env.ORCA_USER_DATA_PATH
    const env = new NodeAppEnvironment()
    // Must land in an Orca-named directory, not a surprise path.
    expect(env.getPath('userData')).toMatch(/Orca$/)
  })

  it('runs will-quit handlers exactly once on quit', () => {
    const env = new NodeAppEnvironment({ userDataPath: '/x' })
    let calls = 0
    env.onWillQuit(() => {
      calls += 1
    })
    // Exercise the private runner via quit without exiting the test process.
    const realExit = process.exit
    process.exit = (() => {}) as never
    try {
      env.quit()
      env.quit()
    } finally {
      process.exit = realExit
    }
    expect(calls).toBe(1)
  })
})

describe('NodeSecretStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-secret-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips an encrypted string', () => {
    const store = new NodeSecretStore({ userDataPath: dir })
    expect(store.isEncryptionAvailable()).toBe(true)
    const cipher = store.encryptString('super-secret-token')
    expect(Buffer.isBuffer(cipher)).toBe(true)
    // Ciphertext must not contain the plaintext.
    expect(cipher.toString('utf8')).not.toContain('super-secret-token')
    expect(store.decryptString(cipher)).toBe('super-secret-token')
  })

  it('decrypts ciphertext written by a previous instance (persistent key)', () => {
    const cipher = new NodeSecretStore({ userDataPath: dir }).encryptString('persist-me')
    // A fresh instance must reuse the persisted key and decrypt successfully.
    expect(new NodeSecretStore({ userDataPath: dir }).decryptString(cipher)).toBe('persist-me')
  })

  it('does not replace an existing invalid key with a fresh key', () => {
    const keyPath = join(dir, 'node-secret-store.key')
    writeFileSync(keyPath, 'not-a-valid-32-byte-key')

    expect(() => new NodeSecretStore({ userDataPath: dir }).encryptString('secret')).toThrow(
      /invalid encryption key/
    )
    expect(readFileSync(keyPath, 'utf8')).toBe('not-a-valid-32-byte-key')
  })

  it('rejects non-Orca ciphertext so callers fall back to plaintext-legacy handling', () => {
    const store = new NodeSecretStore({ userDataPath: dir })
    expect(() => store.decryptString(Buffer.from('legacy-plaintext-token'))).toThrow()
  })

  it('honors a forced encryptionAvailable=false (plaintext-fallback contract)', () => {
    const store = new NodeSecretStore({ userDataPath: dir, encryptionAvailable: false })
    expect(store.isEncryptionAvailable()).toBe(false)
    expect(() => store.encryptString('x')).toThrow()
  })
})
